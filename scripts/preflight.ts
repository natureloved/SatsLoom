/**
 * `npm run preflight` — get a regtest deployment ready to demo.
 *
 * Regtest epochs are ~10 minutes, so onboarding takes confirmations and must happen *before*
 * anyone records a video. This script does the whole cold start and reports progress at each
 * step: faucet → onboard merchant → onboard demo payer → verify balances → print what to do next.
 *
 *   npm run preflight
 *   npm run preflight -- --amount 1000000 --wait
 */
import { TachiAdapter } from "@satsloom/tachi-adapter";
import { loadDotEnv } from "@satsloom/shared";

loadDotEnv();

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : undefined;
};
const amount = BigInt(flag("amount") ?? process.env.DEMO_FUND_SATS ?? "500000");
const wait = args.includes("--wait");

async function main() {
  const adapter = new TachiAdapter({ provider: process.env.TACHI_PROVIDER === "fixture" ? "fixture" : "live" });
  const status = await adapter.getStatus();

  console.log(`\n  SatsLoom preflight · provider=${adapter.providerKind} mode=${status.mode}`);
  console.log(`  daemon: ${adapter.daemonBaseUrl}`);
  if (status.mode === "degraded") {
    console.log(`\n  The daemon is unreachable: ${status.detail}`);
    console.log(`  Fix connectivity first — nothing below can work offline.\n`);
    process.exitCode = 1;
    return;
  }

  for (const role of ["merchant", "demoPayer", "cold"] as const) {
    if (!adapter.hasIdentity(role)) {
      console.log(`\n  Missing ${role} key material. Set ${role === "demoPayer" ? "DEMO_PAYER_MNEMONIC" : role === "cold" ? "COLD_MNEMONIC" : "MERCHANT_MNEMONIC"} (see .env.example).`);
      process.exitCode = 1;
      return;
    }
  }

  const results: { role: string; address: string; before: bigint; after: bigint; txid?: string }[] = [];

  for (const role of ["merchant", "demoPayer"] as const) {
    const target = await adapter.targetFor(role);
    const before = await adapter.getSpendableBalance(role);
    console.log(`\n  ${role}`);
    console.log(`    funding address  ${target.fundingAddress ?? target.address}`);
    console.log(`    ledger address   ${target.address}`);
    console.log(`    balance before   ${before} sats`);

    if (before >= amount) {
      console.log(`    already funded — skipping`);
      results.push({ role, address: target.address, before, after: before });
      continue;
    }

    process.stdout.write(`    faucet… `);
    const faucet = await adapter.fundFromFaucet(target.fundingAddress ?? target.address, amount);
    console.log(`ok (${faucet.txid.slice(0, 20)}…)`);

    process.stdout.write(`    onboard ${amount} sats onto the ledger… `);
    const onboard = await adapter.onboard(role, amount);
    console.log(`broadcast ${onboard.txid.slice(0, 20)}…`);

    if (wait) {
      process.stdout.write(`    waiting for the epoch to commit (regtest is ~10 min/block)… `);
      const committed = await adapter.awaitCommit(onboard.txid, Number(process.env.TACHI_COMMIT_TIMEOUT_MS ?? 900_000));
      console.log(`${committed.state} (epoch ${committed.epoch})`);
    }

    const after = await adapter.getSpendableBalance(role);
    console.log(`    balance after    ${after} sats`);
    results.push({ role, address: target.address, before, after, txid: onboard.txid });
  }

  console.log(`\n  Summary`);
  for (const result of results) {
    const delta = result.after - result.before;
    console.log(`  · ${result.role.padEnd(10)} ${delta >= 0n ? "+" : ""}${delta} sats  →  ${result.after} spendable`);
  }

  const merchant = results.find((result) => result.role === "merchant");
  if (merchant && merchant.after === 0n) {
    console.log(`\n  The merchant balance is still 0. ${wait ? "The epoch may not have committed yet — re-run to check." : "Re-run with --wait to block until the epoch commits."}`);
  } else {
    console.log(`\n  Ready to demo. Next:`);
    console.log(`    npm run dev            # API on :3001, web on :5173`);
    console.log(`    npm run spike:tachi    # confirm every capability is green`);
  }
  console.log("");
}

main().catch((error) => {
  console.error(`\n  preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
