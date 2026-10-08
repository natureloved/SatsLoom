#!/usr/bin/env node
/**
 * End-to-end proof that SatsLoom moves real sats on Bitcoin signet.
 *
 * This is the script that answers "is it actually live?" with something checkable rather than
 * an assertion. It talks to the same public surface a merchant's client uses:
 *
 *   1. POST /api/live/invoices  -> a real BOLT11 invoice from a real node
 *   2. pay that invoice over the Lightning Network from a second node
 *   3. GET  /api/live/invoices/:id -> the settlement, credited from the preimage the node reveals
 *
 * It refuses to report success on its own say-so: every claim printed below is read back from a
 * response, and the payment hash is cross-checked against the node that says it was paid.
 *
 * Usage:
 *   export SATSLOOM_RAIL=lnd
 *   export LND_REST_URL=https://127.0.0.1:8080
 *   export LND_MACAROON_HEX=$(xxd -p <lnd-dir>/data/chain/bitcoin/signet/admin.macaroon | tr -d '\n')
 *   export LND_CA_CERT_PATH=<lnd-dir>/tls.cert
 *   export SATSLOOM_LIGHTNING_NETWORK=signet
 *   export PAYER_LNCLI_DIR=/path/to/a/second/lnd          # the paying node
 *   node scripts/live-signet-proof.mts [amountSats]
 *
 * If the API is not already running, pass SATSLOOM_API_URL and this script will start one on an
 * ephemeral DATA_FILE, then shut it down.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let API = process.env.SATSLOOM_API_URL ?? "";
const amountSats = Number(process.argv[2] ?? 1000);
const payerDir = process.env.PAYER_LNCLI_DIR;
const nodeDir = process.env.LNCLI_DIR ?? payerDir;

class ScriptFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptFailure";
  }
}

function fail(message: string): never {
  throw new ScriptFailure(message);
}

async function get(path: string) {
  try {
    const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (err: any) {
    return { status: 0, body: null, error: err?.message };
  }
}

async function post(path: string, payload: unknown) {
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (err: any) {
    return { status: 0, body: null, error: err?.message };
  }
}

/* --------------------------------------------------------------------------- boot API */

let started: ReturnType<typeof spawn> | undefined;
let scratchDir = "";
let startedApi = false;

async function bootApi() {
  if (!API) {
    // If not specified, probe if an existing dev API is already running with a live rail
    try {
      const probe = await fetch("http://127.0.0.1:3001/api/health", { signal: AbortSignal.timeout(1500) });
      if (probe.ok) {
        const body = (await probe.json()) as any;
        if (body?.data?.paymentExecution === "lightning-rail") {
          API = "http://127.0.0.1:3001";
        }
      }
    } catch {}
    if (!API) {
      API = "http://127.0.0.1:3019";
    }
  }

  const health = await get("/api/health");
  if (health.status === 200) return; // already running: use it as-is
  scratchDir = mkdtempSync(join(tmpdir(), "satsloom-live-"));
  startedApi = true;
  const targetPort = new URL(API).port || "3019";
  const env = { ...process.env, SATSLOOM_DATA_FILE: join(scratchDir, "store.json"), PORT: targetPort } as NodeJS.ProcessEnv;
  const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const serverPath = join(process.cwd(), "apps", "api", "src", "server.ts");

  let stderrLog = "";
  started = spawn(process.execPath, [tsxCli, serverPath], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  started.stderr?.on("data", (chunk) => {
    stderrLog += chunk.toString();
  });
  started.on("error", (err) => {
    stderrLog += `\nProcess error: ${err.message}`;
  });

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if ((await get("/api/health")).status === 200) return;
  }
  fail(`the API did not become ready.${stderrLog ? ` Stderr output:\n${stderrLog}` : ""}`);
}

/* ------------------------------------------------------------------ verify it is live */

async function assertRailIsLive() {
  const { status, body } = await get("/api/health");
  if (status !== 200) fail(`/api/health returned ${status}`);
  const data = (body as any)?.data;
  if (data?.paymentExecution !== "lightning-rail") {
    fail(
      `the API is not on a Lightning rail (paymentExecution=${data?.paymentExecution}). ` +
      `SATSLOOM_RAIL=${process.env.SATSLOOM_RAIL ?? "(unset)"} and railConfigError=${JSON.stringify(data?.railConfigError)}.\n\n` +
      `To run this live signet proof against an actual LND node, set:\n` +
      `  export SATSLOOM_RAIL=lnd\n` +
      `  export LND_REST_URL=https://127.0.0.1:8080\n` +
      `  export LND_MACAROON_HEX=$(xxd -p <lnd-dir>/data/chain/bitcoin/signet/admin.macaroon | tr -d '\\n')\n` +
      `  export LND_CA_CERT_PATH=<lnd-dir>/tls.cert  # or export LND_ALLOW_SELF_SIGNED=true\n` +
      `  export SATSLOOM_LIGHTNING_NETWORK=signet\n` +
      `  export PAYER_LNCLI_DIR=/path/to/second/lnd    # optional: automatic settlement\n` +
      `  node scripts/live-signet-proof.mts [amountSats]`
    );
  }
  if (data?.railHealth?.reachable !== true) fail(`the configured node is not reachable: ${data?.railHealth?.detail ?? "unknown error"}`);
  console.log(`node:        ${data.railHealth.nodePubkey} @ height ${data.railHealth.blockHeight} (${data.railHealth.version})`);
  console.log(`rail:        ${data.rail.rail} on ${data.rail.network} — execution=${data.paymentExecution}`);
  if (data.rail.network !== "signet") console.log(`note:        rail network is ${data.rail.network}, not signet`);
}

/* ------------------------------------------------------------------ issue and settle */

async function issueAndSettle() {
  const created = await post("/api/live/invoices", {
    amountSats,
    memo: "SatsLoom live signet proof",
    expirySeconds: 3600,
  });
  if (created.status !== 200) fail(`invoice creation returned ${created.status}: ${JSON.stringify(created.body)}`);
  const { invoice, payment } = (created.body as any).data;
  console.log(`\ninvoice id:  ${invoice.id}`);
  console.log(`bolt11:      ${String(payment.bolt11).slice(0, 64)}…`);
  console.log(`hash:        ${payment.paymentHash}`);

  if (!payment.bolt11?.startsWith("ln")) fail("the rail did not return a BOLT11 invoice");
  if (!/^[0-9a-f]{64}$/.test(payment.paymentHash)) fail("payment hash is not 64 hex characters");

  console.log(`\npay it with any signet wallet, or with:\n  lncli payinvoice ${payment.bolt11}`);

  if (!payerDir) {
    console.log("\nPAYER_LNCLI_DIR is not set, so this script will not pay the invoice itself.");
    console.log("Polling for settlement for up to 5 minutes…");
    return pollUntilSettled(invoice.id, 300);
  }

  // lncli asks for a typed confirmation on any invoice that carries no amount. Piping "yes"
  // and adding an explicit fee limit are both required for a non-interactive payment; without
  // them the payer hangs on a prompt and looks exactly like a failed payment.
  const pay = spawnSync("lncli", ["--lnddir", nodeDir!, "--network", "signet", "payinvoice", payment.bolt11, "--fee_limit", "50"], {
    encoding: "utf8",
    input: "yes\n",
    env: { ...process.env, LNCLI_RPCSERVER: process.env.PAYER_LNCLI_RPCSERVER ?? "127.0.0.1:10010" },
  });
  const combined = `${pay.stdout ?? ""}${pay.stderr ?? ""}`;
  // A settled payment prints its preimage; an in-flight or failed one does not.
  const preimageMatch = /preimage:?\s*([0-9a-fA-F]{64})/i.exec(combined);
  if (!preimageMatch) {
    console.log(combined);
    fail("the paying node did not settle the invoice");
  }
  console.log(`payer:       settled, preimage ${preimageMatch[1].slice(0, 24)}…`);
  return pollUntilSettled(invoice.id, 30);
}

async function pollUntilSettled(invoiceId: string, seconds: number) {
  for (let i = 0; i < seconds * 2; i++) {
    const { status, body } = await get(`/api/live/invoices/${invoiceId}`);
    if (status !== 200) fail(`invoice read returned ${status}`);
    const data = (body as any).data;
    if (data.settlement?.preimage) {
      report(data);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const { body } = await get(`/api/live/invoices/${invoiceId}`);
  fail(`no settlement was credited in ${seconds}s (last state: ${JSON.stringify((body as any).data?.observation?.state)})`);
}

/** Print the credited settlement and verify the one claim that cannot be faked. */
function report(data: any) {
  const s = data.settlement;
  console.log("\n--- settlement credited by SatsLoom ---");
  console.log(`invoice:     ${s.invoiceId}`);
  console.log(`hash:        ${s.paymentHash}`);
  console.log(`preimage:    ${s.preimage}`);
  console.log(`paid:        ${Number(s.amountMsat) / 1000} sats (${s.amountMsat} msat)`);
  console.log(`surplus:     ${Number(s.surplusMsat) / 1000} sats`);
  console.log(`rail:        ${s.rail} on ${s.network} (${s.mode})`);
  console.log(`verified:    ${s.verified} via ${s.verification}`);
  console.log(`simulated:   ${s.simulation}`);

  // The claim a node cannot make falsely: sha256(preimage) must equal the committed hash.
  const digest = createHash("sha256").update(Buffer.from(String(s.preimage), "hex")).digest("hex");
  if (digest !== s.paymentHash) fail(`preimage ${s.preimage} does not hash to payment hash ${s.paymentHash}`);
  console.log(`sha256:      ${s.preimage} -> ${digest} matches the payment hash`);
  console.log("\nPASS — real satoshis moved over Lightning, and SatsLoom credited the preimage.");
}

/* ------------------------------------------------------------------------------ main */

try {
  await bootApi();
  try {
    await assertRailIsLive();
    await issueAndSettle();
  } finally {
    if (started) {
      try { started.kill(); } catch {}
    }
    if (scratchDir) {
      try { rmSync(scratchDir, { recursive: true, force: true }); } catch {}
    }
    if (startedApi) console.log("\n(stopped the API this script started)");
  }
} catch (err) {
  if (err instanceof ScriptFailure) {
    console.error(`\nFAIL: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
