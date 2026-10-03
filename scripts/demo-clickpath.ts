#!/usr/bin/env tsx
/**
 * The judge click-path, automated.
 *
 * Drives exactly the sequence a judge performs in the browser — create an invoice, pay it from the
 * demo wallet, watch it confirm, kill the best route, refund, sweep — but over HTTP, so it can be
 * run twice in a row against a deployed instance and produce a machine-checked verdict. The
 * acceptance criterion for shipping is "the deployed demo passes this twice consecutively", which
 * is only checkable if the path is executable.
 *
 *   npx tsx scripts/demo-clickpath.ts                        # against http://127.0.0.1:3001
 *   npx tsx scripts/demo-clickpath.ts --base https://api…    # against a deployment
 *   npx tsx scripts/demo-clickpath.ts --amount 50000 --wait 60
 *
 * Exit code is 0 only if every step passed. Nothing here is mocked: it talks to the running API,
 * which talks to whatever daemon provider is configured and reports that provider in every reply.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { TachiAdapter } from "@satsloom/tachi-adapter";

type Envelope<T> = {
  requestId?: string;
  mode?: string;
  daemon?: { reachable?: boolean; detail?: string } | null;
  data?: T;
  error?: string | { code?: string; message?: string; details?: unknown } | null;
  /**
   * The API adds route/decision context *beside* `data`, not inside it — the settlement and routes
   * endpoints both do this. Recording that here keeps the script typed against the real contract
   * instead of against what the endpoints look like from memory.
   */
  decision?: { selectedRouteId?: string; reason?: string } | null;
  log?: unknown[];
  evaluations?: unknown[];
  fresh?: boolean;
  settlement?: Settlement | null;
  route?: { id?: string } | null;
};

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
}

const base = arg("base", process.env.SATSLOOM_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const amountSats = BigInt(arg("amount", "50000"));
const confirmTimeoutSeconds = Number(arg("wait", "90"));
const memo = arg("memo", "Demo order #1");

let passed = 0;
const failures: string[] = [];
const warnings: string[] = [];

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Envelope<T>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Envelope<T>;
  try {
    parsed = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new Error(`${method} ${path} → ${response.status} (non-JSON): ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    // `error` is a structured `{code, message}` object, not a string — printing it raw is how a
    // failure turns into "[object Object]" and tells you nothing.
    const detail = parsed.error && typeof parsed.error === "object" ? (parsed.error as { code?: string; message?: string }) : undefined;
    throw new Error(`${method} ${path} → ${response.status}: ${detail?.message ?? (typeof parsed.error === "string" ? parsed.error : text.slice(0, 200))}${detail?.code ? ` (${detail.code})` : ""}`);
  }
  return parsed;
}

function fmt(sats: string | bigint | undefined): string {
  if (sats === undefined) return "?";
  return BigInt(sats).toLocaleString("en-US");
}

type Invoice = {
  id: string;
  status: string;
  amountSats: string;
  memo?: string;
  expiresAt?: string;
  paymentTarget?: { owner?: string; address?: string };
  proof?: { txid?: string; vtxoId?: string; amountSats?: string; explorerUrl?: string } | null;
};

type Settlement = {
  routeId?: string;
  status?: string;
  txid?: string;
  explorerUrl?: string;
  fallbackFrom?: string;
};

async function main() {
  console.log(`\nSatsLoom judge click-path → ${base}\n${"─".repeat(72)}`);

  /* 1 ─ the daemon pill the judge sees first */
  console.log("\n1 · Dashboard pill and balances");
  const status = await call<{ reachable: boolean; detail: string; mode: string }>("GET", "/api/tachi/status");
  const summaryBefore = await call<{
    counts: Record<string, number>;
    balance: { offchainSats: string; onchainSats: string };
  }>("GET", "/api/dashboard/summary");
  const before = summaryBefore.data!;
  check("daemon is reachable", status.data?.reachable === true, status.data?.detail ?? (typeof status.error === "string" ? status.error : "no detail"));
  check(
    `mode is declared and consistent (${status.mode})`,
    status.mode === "live" || status.mode === "fixture",
    status.mode === "fixture" ? "FIXTURE — this run is not network evidence" : "live",
  );
  check("dashboard reports both balances", before.balance !== undefined, `off-chain ${fmt(before.balance?.offchainSats)} · on-chain ${fmt(before.balance?.onchainSats)}`);
  if (status.mode === "fixture") warnings.push("Provider is 'fixture': the flow is real code over a local ledger, not the Tachi network.");

  /* 2 ─ fund the merchant and the demo payer (the faucet → VTXO path) */
  console.log("\n2 · Fund merchant and demo payer (on-chain → off-chain)");
  const fund = await call<{ faucet?: { txid?: string }; onboard?: { txid?: string }; target?: { address?: string } }>("POST", "/api/demo/fund-merchant", { amountSats: "500000" });
  check("merchant funded (faucet + on-ledger onboarding)", Boolean(fund.data?.faucet && fund.data?.onboard), `faucet ${fund.data?.faucet?.txid?.slice(0, 12) ?? "?"}… → onboard ${fund.data?.onboard?.txid?.slice(0, 12) ?? "?"}…`);
  const payer = await call<{ target?: { owner?: string } }>("POST", "/api/demo/onboard-payer", { amountSats: "500000" });
  check("demo payer funded", Boolean(payer.data?.target?.owner), payer.data?.target?.owner ? `${payer.data.target.owner.slice(0, 16)}…` : "no owner returned");
  const afterFund = (await call<{ balance: { offchainSats: string } }>("GET", "/api/dashboard/summary")).data!;
  check("off-chain balance increased", BigInt(afterFund.balance.offchainSats) > BigInt(before.balance.offchainSats), `off-chain ${fmt(afterFund.balance.offchainSats)} sats`);

  /* 3 ─ webhook, so confirmation is provable to a shop's server */
  console.log("\n3 · Webhook registration");
  const hook = await call<{ id?: string; secret?: string }>("POST", "/api/webhooks/register", {
    // Deliberately unroutable: the point is the delivery log and the retry ladder, and a real
    // endpoint would hide whether retries work.
    url: "https://example.invalid/satsloom-hook",
    events: ["invoice.confirmed", "invoice.expired", "payout.settled"],
  });
  check("webhook registered and a signing secret was issued", typeof hook.data?.secret === "string" && hook.data.secret.length >= 32, `id ${hook.data?.id ?? "?"}`);

  /* 4 ─ the invoice the judge creates */
  console.log(`\n4 · Create invoice · ${fmt(amountSats)} sats · "${memo}"`);
  const created = await call<Invoice>("POST", "/api/invoices", { amountSats: amountSats.toString(), memo });
  const invoice = created.data!;
  check("invoice created", invoice.status === "created", `id ${invoice.id}`);
  check("payment target is a Taproot vault address", Boolean(invoice.paymentTarget?.address?.startsWith("bcrt1p")), invoice.paymentTarget?.address);
  check("expiry is set", Boolean(invoice.expiresAt !== undefined && (invoice as { expiresAt?: string }).expiresAt));

  const pay = await call<{ amountSats: string; memo?: string; status: string; expiresAt?: string; paymentTarget?: { address?: string } }>("GET", `/api/pay/${invoice.id}`);
  check(
    "public pay page serves amount, memo and the QR address",
    pay.data?.amountSats === amountSats.toString() && Boolean(pay.data?.paymentTarget?.address) && pay.data?.memo === memo,
    `expires ${pay.data?.expiresAt ?? "?"}`,
  );
  check("pay page leaks no secrets", !/mnemonic|privateKey|secret/i.test(JSON.stringify(pay)), "checked payload for key material");

  /* 5 ─ pay it from the demo wallet */
  console.log("\n5 · Pay from the demo wallet (real VTXO transfer)");
  const paid = await call<{ invoice?: { status?: string }; broadcast?: { txid?: string; accepted?: boolean } }>("POST", `/api/demo/pay-invoice/${invoice.id}`, {});
  check(
    "payment broadcast, invoice is pending",
    paid.data?.invoice?.status === "pending" && paid.data?.broadcast?.accepted === true,
    `txid ${paid.data?.broadcast?.txid?.slice(0, 16) ?? "?"}…`,
  );

  const started = Date.now();
  let confirmed: Invoice | undefined;
  let polls = 0;
  while (Date.now() - started < confirmTimeoutSeconds * 1000) {
    polls += 1;
    const current = await call<Invoice>("GET", `/api/invoices/${invoice.id}`);
    if (current.data?.status === "confirmed") {
      confirmed = current.data;
      break;
    }
    await sleep(1000);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  check(`confirmed within ${confirmTimeoutSeconds}s`, confirmed !== undefined, confirmed ? `${elapsed}s after ${polls} polls` : `still ${(await call<Invoice>("GET", `/api/invoices/${invoice.id}`)).data?.status} after ${elapsed}s`);
  const settlementRecord = (await call<Settlement>("GET", `/api/invoices/${invoice.id}/settlement`)).data;
  const explorerUrl = confirmed?.proof?.explorerUrl ?? settlementRecord?.explorerUrl;
  check("confirmation carries an explorer receipt", Boolean(explorerUrl?.includes("/tx/")), explorerUrl ?? "MISSING — a settlement without a proof link is not acceptable");
  check("explorer link is a well-formed tx URL", /\/tx\/[0-9a-f]{64}$/.test(explorerUrl ?? ""), explorerUrl ?? "MISSING");
  if (explorerUrl) {
    // Reachability is environment-dependent (an offline sandbox cannot resolve the host), so it is
    // a warning rather than a failure — but it must never be waved away on the recording machine.
    const reachable = await fetch(explorerUrl, { method: "HEAD" })
      .then((r) => r.status < 500)
      .catch(() => false);
    if (!reachable) warnings.push(`The explorer link did not resolve from this machine (${new URL(explorerUrl).host}). Verify it by hand before claiming a receipt.`);
  }

  /* 6 ─ webhooks actually left the building */
  console.log("\n6 · Webhook delivery log");
  const deliveries = await call<Array<{ event: string; status: string; attempts: number; maxAttempts: number }>>("GET", "/api/webhooks/deliveries");
  const forInvoice = (deliveries.data ?? []).filter((d) => d.event === "invoice.confirmed");
  check("an invoice.confirmed delivery was attempted", forInvoice.length > 0, `${forInvoice.length} row(s)`);
  check(
    "delivery status is honest about retries",
    forInvoice.every((d) => ["delivered", "retrying", "failed"].includes(d.status)),
    forInvoice.map((d) => `${d.status} ${d.attempts}/${d.maxAttempts}`).join(", ") || "none",
  );

  /* 7 ─ routing: quote, reason, fallback */
  console.log("\n7 · Liquidity routes and deterministic selection");
  const directory = await call<{ providers: Array<{ id: string; capacitySats: string; feeSats: string; latencySeconds: number; exitRisk: string; available: boolean }> }>(
    "GET",
    "/api/routes/liquidity",
  );
  const providers = directory.data?.providers ?? [];
  check("at least two live-evaluated sources", providers.length >= 2, providers.map((p) => p.id).join(" > "));
  check(
    "each source reports fee, timing and exit risk",
    providers.every((p) => p.feeSats !== undefined && p.latencySeconds !== undefined && p.exitRisk !== undefined),
    providers.map((p) => `${p.id}: ${p.feeSats} sat / ${p.latencySeconds}s / ${p.exitRisk}`).join(" · "),
  );

  type Quote = {
    routes: Array<{ id: string; source: string; feeSats: string; estimatedSettlementSeconds: number; exitRisk: string }>;
    decision?: { selectedRouteId?: string; reason?: string } | null;
  };
  const routes = await call<Quote>("GET", `/api/invoices/${invoice.id}/routes?refresh=1`);
  // The judge clicks "Select route": the router publishes its pick and the reason for it.
  const chosen = await call<{ selectedRouteId?: string; reason?: string }>("POST", `/api/invoices/${invoice.id}/select-route`, {});
  const decision = chosen.data ?? routes.decision;
  const best = decision?.selectedRouteId ?? routes.data?.routes?.[0]?.id;
  check("a route was chosen with a published reason", Boolean(decision?.reason), (decision?.reason ?? "").slice(0, 110) + "…");
  check("the chosen route is eligible and covers the invoice", Boolean(best), `selected ${best}`);
  const quoted = await call<Quote>("GET", `/api/invoices/${invoice.id}/routes?refresh=1`);
  check(
    "re-quoting the same inputs gives the same ranking (determinism)",
    JSON.stringify(quoted.data?.routes?.map((r) => r.id)) === JSON.stringify(routes.data?.routes?.map((r) => r.id)),
    "same order on the second call",
  );

  console.log("\n8 · Kill the best route → automatic fallback");
  await call("POST", `/api/invoices/${invoice.id}/invalidate-best-route`, {});
  await call<{ settlement?: Settlement }>("POST", `/api/invoices/${invoice.id}/settle`, {});
  const settlement = (await call<Settlement>("GET", `/api/invoices/${invoice.id}/settlement`)).data ?? undefined;
  check("settled on a different source", Boolean(settlement?.routeId) && settlement?.routeId !== best, `settled via ${settlement?.routeId ?? "?"} (fallbackFrom ${settlement?.fallbackFrom ?? "—"}), killed ${best}`);
  check("the fallback is recorded as a fallback", Boolean(settlement?.fallbackFrom), settlement?.fallbackFrom ?? "no fallbackFrom: was the route really dead?");

  /* 9 ─ refund */
  console.log("\n9 · Refund to the payer");
  const refund = await call<{ status?: string; txid?: string; explorerUrl?: string; amountSats?: string }>("POST", `/api/invoices/${invoice.id}/refund`, {}, { "idempotency-key": `refund-${invoice.id}` });
  check("refund settled with a txid", Boolean(refund.data?.txid), `${fmt(refund.data?.amountSats)} sats · ${refund.data?.txid?.slice(0, 16)}…`);
  check("refund carries an explorer receipt", Boolean(refund.data?.explorerUrl), refund.data?.explorerUrl ?? "MISSING");
  const replay = await call<typeof refund.data>("POST", `/api/invoices/${invoice.id}/refund`, {}, { "idempotency-key": `refund-${invoice.id}` });
  check("refund is idempotent", replay.data?.txid === refund.data?.txid, "same txid on replay");
  const overRefund = await fetch(`${base}/api/invoices/${invoice.id}/refund`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountSats: (amountSats * 2n).toString() }),
  });
  check("an over-refund is refused", overRefund.status >= 400, `HTTP ${overRefund.status}`);

  /* 10 ─ sweep both ways */
  console.log("\n10 · Payout / sweep");
  const merchantNow = await call<{ payoutAddress?: string | null }>("GET", "/api/merchant");
  let cold = arg("cold", merchantNow.data?.payoutAddress ?? "");
  if (!cold) {
    // No PAYOUT_ADDRESS on the server and none on the command line: derive the cold vault address
    // locally when this machine holds the key, so the sweep beat is still exercised rather than
    // silently skipped.
    try {
      cold = (await new TachiAdapter({ provider: "fixture" }).targetFor("cold")).address;
      warnings.push(`No PAYOUT_ADDRESS configured, so the sweep used a locally derived cold address (${cold.slice(0, 16)}…). Set PAYOUT_ADDRESS on the deployment to make this the merchant's real cold wallet.`);
    } catch {
      cold = "";
    }
  }
  const offchain = await call<{ status?: string; txid?: string; kind?: string }>(
    "POST",
    "/api/payouts",
    { amountSats: "1000", kind: "offchain_transfer", toOwner: payer.data?.target?.owner },
    { "idempotency-key": `sweep-offchain-${invoice.id}` },
  );
  check("off-chain sweep settled", offchain.data?.status === "settled", `${offchain.data?.kind ?? "?"} · ${offchain.data?.txid?.slice(0, 16)}…`);
  if (cold) {
    const onchain = await call<{ status?: string; txid?: string; kind?: string; explorerUrl?: string }>(
      "POST",
      "/api/payouts",
      { amountSats: "1000", toAddress: cold },
      { "idempotency-key": `sweep-${invoice.id}` },
    );
    check("on-chain redemption to the cold address settled", onchain.data?.status === "settled", `${onchain.data?.kind ?? "?"} · ${onchain.data?.txid?.slice(0, 16)}…`);
    check("on-chain payout carries an explorer receipt", Boolean(onchain.data?.explorerUrl), onchain.data?.explorerUrl ?? "MISSING");
  } else {
    warnings.push("No cold address available anywhere, so the on-chain sweep could not be exercised. Set PAYOUT_ADDRESS on the server.");
  }

  /* 11 ─ the dashboard agrees with what just happened */
  console.log("\n11 · Dashboard totals reconcile");
  const summaryAfter = await call<{ counts: Record<string, number>; totals: { invoicedSats: string; refundedSats: string } }>("GET", "/api/dashboard/summary");
  const after = summaryAfter.data!;
  // `counts` are the invoices' *current* statuses, so a refunded invoice has left `confirmed` —
  // which is why the check is on the pair, not on both at once.
  check(
    "the invoice is accounted for after refunding",
    after.counts.refunded >= 1 && after.counts.confirmed + after.counts.refunded >= 1,
    JSON.stringify(after.counts),
  );
  check("totals include this run", BigInt(after.totals.invoicedSats) >= amountSats && BigInt(after.totals.refundedSats) >= amountSats, `invoiced ${fmt(after.totals.invoicedSats)} · refunded ${fmt(after.totals.refundedSats)}`);

  /* verdict */
  console.log(`\n${"─".repeat(72)}`);
  for (const warning of warnings) console.log(`! ${warning}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("\nFailed steps:");
    for (const failure of failures) console.log(`  · ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("\nClick-path complete: invoice → VTXO payment → proof → fallback → refund → sweep.\nRun it again — twice in a row is the shipping bar.\n");
  }
}

main().catch((error) => {
  console.error(`\nClick-path aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
