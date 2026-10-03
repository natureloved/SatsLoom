/**
 * `npm run spike:tachi` — the Day-1 gate.
 *
 * Probes every Tachi capability SatsLoom depends on, against the configured daemon, and prints a
 * truth table. This is deliberately a *script* and not a test: it needs the live network, so it
 * has to be runnable on an operator's machine and readable by a judge, and its output is the
 * evidence behind the README's "what is live" section.
 *
 *   npm run spike:tachi                 # probe and report
 *   npm run spike:tachi -- --write      # additionally record a receipt to docs/spike-latest.json
 *   npm run spike:tachi -- --fixture    # verify the local harness only (no network)
 *
 * Exit code is 1 if any capability SatsLoom needs for merchant payments is red, so it can gate CI.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TachiAdapter, ROLES, isAdapterError } from "@satsloom/tachi-adapter";
import { describeTimelock, loadDotEnv } from "@satsloom/shared";

loadDotEnv();

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const fixture = args.has("--fixture");

/** Capabilities whose failure blocks the merchant loop (bounty #11) rather than only #10. */
const CRITICAL = new Set(["daemon-reachable", "validators", "vault-derivation", "vtxo-query", "ledger-signing", "transfer-broadcast"]);

async function main() {
  const env = fixture ? { ...process.env, TACHI_PROVIDER: "fixture" } : process.env;
  const adapter = new TachiAdapter({ provider: fixture ? "fixture" : "live", env });

  console.log(`\n  SatsLoom · Tachi capability spike`);
  console.log(`  provider   ${adapter.providerKind}${fixture ? " (local harness — proves the code path, not the network)" : ""}`);
  console.log(`  daemon     ${adapter.daemonBaseUrl}`);
  console.log(`  network    ${env.TACHI_NETWORK ?? "regtest"}`);
  console.log(`  csv blocks ${env.TACHI_CSV_BLOCKS ?? 1008}\n`);

  const report = await adapter.capabilities();
  const rows: { id: string; label: string; ok: boolean; detail: string; remediation?: string }[] = report.capabilities.map((capability) => ({
    id: capability.id,
    label: capability.label,
    ok: capability.ok,
    detail: capability.detail ?? "",
    remediation: capability.remediation,
  }));

  // Additional probes that only make sense with an identity configured.
  const extra: typeof rows = [];

  if (adapter.hasIdentity("merchant")) {
    const target = await adapter.targetFor("merchant").catch((error) => {
      extra.push({
        id: "payment-target",
        label: "Merchant payment target",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        remediation: "Check that the daemon's validator registry is reachable and returns ≥5 keys.",
      });
      return null;
    });
    if (target) {
      extra.push({
        id: "payment-target",
        label: "Merchant payment target",
        ok: target.address.startsWith("bcrt1p") || (env.TACHI_NETWORK ?? "regtest") !== "regtest",
        detail: `${target.address} (owner ${target.owner.slice(0, 16)}…)`,
        remediation: "A regtest account address must start with bcrt1p (P2TR). If it does not, the vault builder and the daemon disagree about the quorum or CSV.",
      });
    }

    const balance = await adapter.getSpendableBalance("merchant").catch(() => null);
    extra.push({
      id: "merchant-balance",
      label: "Merchant ledger balance",
      ok: balance !== null,
      detail: balance === null ? "query failed" : `${balance} sats spendable`,
      remediation: "Run `npm run preflight` to faucet-fund and onboard the merchant account.",
    });

    const vtxos = await adapter.getAddressVtxos(target?.owner ?? "").catch(() => []);
    extra.push({
      id: "merchant-vtxos",
      label: "Merchant VTXO set",
      ok: true,
      detail: `${vtxos.length} VTXO${vtxos.length === 1 ? "" : "s"}${vtxos.length ? ` · largest ${vtxos.reduce((max, v) => (v.amountSats > max ? v.amountSats : max), 0n)} sats` : " (fund the account before recording)"}`,
    });
  } else {
    extra.push({
      id: "merchant-identity",
      label: "Merchant identity",
      ok: false,
      detail: "MERCHANT_MNEMONIC is not set",
      remediation: "Copy .env.example to .env and set MERCHANT_MNEMONIC (and DEMO_PAYER_MNEMONIC) to your regtest mnemonics.",
    });
  }

  // Round-trip proof: broadcast a real signed transaction and read its status back.
  if (adapter.hasIdentity("merchant") && !fixture) {
    const balance = await adapter.getSpendableBalance("merchant").catch(() => 0n);
    if (balance > 2000n) {
      try {
        const payer = await adapter.targetFor("demoPayer");
        const transfer = await adapter.transferSats({ from: "merchant", toOwner: payer.owner, amountSats: 1000n, memo: "spike round-trip" });
        const status = await adapter.getTxStatus(transfer.txid);
        extra.push({
          id: "transfer-broadcast",
          label: "Transfer broadcast + status read-back",
          ok: transfer.accepted,
          detail: `txid ${transfer.txid.slice(0, 20)}… state=${status.state} epoch=${status.epoch}`,
          remediation: "A rejection here carries the daemon's own log in the error details — read it before changing code.",
        });
      } catch (error) {
        extra.push({
          id: "transfer-broadcast",
          label: "Transfer broadcast + status read-back",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          remediation: isAdapterError(error) && error.code === "transfer_rejected" ? "The daemon rejected the envelope: check its `log` field — usually a nonce, quorum or fee mismatch." : "Check daemon connectivity and that the merchant holds committed VTXOs.",
        });
      }
    } else {
      extra.push({
        id: "transfer-broadcast",
        label: "Transfer broadcast + status read-back",
        ok: false,
        detail: `merchant holds ${balance} sats — need >2000 to prove a transfer`,
        remediation: "Run `npm run preflight` first, then re-run this spike.",
      });
    }
  }

  const all = [...rows, ...extra];
  const width = Math.max(...all.map((row) => row.label.length), 10);
  console.log(`  ${"CAPABILITY".padEnd(width)}  RESULT  DETAIL`);
  console.log(`  ${"-".repeat(width)}  ------  ${"-".repeat(48)}`);
  for (const row of all) {
    const mark = row.ok ? "  ok  " : " FAIL ";
    console.log(`  ${row.label.padEnd(width)}  ${mark}  ${row.detail}`);
    if (!row.ok && row.remediation) console.log(`  ${" ".repeat(width)}          ↳ ${row.remediation}`);
  }

  // Show what the routing directory looks like, since that is bounty #10's evidence.
  try {
    const providers = await adapter.liquidityDirectory();
    console.log(`\n  Liquidity directory (${providers.length} sources)`);
    for (const provider of providers) {
      const timing = describeTimelock({ estimatedSettlementSeconds: provider.latencySeconds, timelockBlocks: provider.timelockBlocks });
      console.log(
        `  · ${provider.name.padEnd(30)} ${provider.status.padEnd(11)} fee ${String(provider.feeSats).padStart(6)} sats  ${timing.friendly.padEnd(26)} cap ${provider.capacitySats} sats`,
      );
      if (provider.detail) console.log(`    ${provider.detail}`);
    }
  } catch (error) {
    console.log(`\n  Liquidity directory unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const failed = all.filter((row) => !row.ok);
  const blocking = failed.filter((row) => CRITICAL.has(row.id));
  const overall = report.mode;

  console.log(`\n  mode: ${overall}`);
  console.log(`  ${all.length - failed.length}/${all.length} capabilities green${blocking.length ? ` — ${blocking.length} blocking` : ""}`);

  if (write) {
    const path = resolve("docs/spike-latest.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ at: new Date().toISOString(), provider: adapter.providerKind, mode: overall, daemon: adapter.daemonBaseUrl, capabilities: all, identities: Object.fromEntries(ROLES.map((role) => [role, adapter.hasIdentity(role)])) }, null, 2)}\n`,
    );
    console.log(`  receipt written to ${path}`);
  }

  if (blocking.length) {
    console.log(`\n  Day-1 gate: NOT GREEN (${blocking.map((row) => row.id).join(", ")})\n`);
    process.exitCode = 1;
  } else {
    console.log(`\n  Day-1 gate: green\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
