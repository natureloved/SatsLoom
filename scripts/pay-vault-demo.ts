import "dotenv/config";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getTachiTx } from "@tachibtc/taurus-vault-core";
import { TachiSdkAdapter } from "@satsloom/tachi-adapter";

/**
 * Pay-to-vault demo run (signet only).
 *
 * Drives one real invoice through the new flow end to end:
 *   1. creates the merchant vault (or reuses the existing one),
 *   2. creates a demo invoice for a SMALL amount (10,000 sats),
 *   3. starts a pay-to-vault payment intent for it,
 *   4. pays the invoice from the completed fund run's funding wallet
 *      (job 8cf6303e's change, ~400,000 sats — its mnemonic is persisted in
 *      the job's mode-600 file, and spending that job's own change for this
 *      authorised demo is the intended recovery pattern; signet only, small
 *      amount only),
 *   5. polls the payment until it is paid, then verifies the registration
 *      against the daemon (state committed, code 0, epoch) and the VTXO
 *      against the merchant vault.
 *
 * No new faucet claim is needed: the operator's 0.005 BTC 24h allowance was
 * used on 2026-11-14 ~18:58 WAT. The script never prints a mnemonic, token,
 * or key. It exits non-zero and prints the failure verbatim when any step
 * fails, so a half-finished run is never reported as a success.
 *
 * Usage: node --experimental-strip-types scripts/pay-vault-demo.ts
 *   SATSLOOM_ADMIN_TOKEN — admin token (else read from the mode-600 file
 *     ~/workspace/drawbound-satsloom/.satsloom-admin-token)
 *   SATSLOOM_API_URL — API base (default http://127.0.0.1:3001)
 *   PAY_VAULT_DEMO_AMOUNT_SATS — invoice amount (default 10000)
 */

const API = (process.env.SATSLOOM_API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const DEMO_AMOUNT_SATS = BigInt(process.env.PAY_VAULT_DEMO_AMOUNT_SATS ?? "10000");
const FUND_JOB_FILE = resolve("apps/api/.data/tachi-fund-jobs/8cf6303e-1acf-47df-9652-25f8a0b05c01.json");
const MERCHANT_VAULT_FILE = resolve("apps/api/.data/tachi-merchant-vault.json");
const ADMIN_TOKEN_FILE = join(homedir(), "workspace", "drawbound-satsloom", ".satsloom-admin-token");
const DAEMON_RPC_URL = process.env.TACHI_DAEMON_RPC_URL ?? "https://rpc-signet.tachibtc.com";

function adminToken(): string {
  if (process.env.SATSLOOM_ADMIN_TOKEN) return process.env.SATSLOOM_ADMIN_TOKEN;
  return readFileSync(ADMIN_TOKEN_FILE, "utf8").trim();
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`API ${init?.method ?? "GET"} ${path} -> ${response.status}: ${body.error ?? body.data?.error ?? JSON.stringify(body).slice(0, 200)}`);
  }
  return body.data;
}

async function main(): Promise<void> {
  const token = adminToken();
  const auth = { authorization: `Bearer ${token}` };

  const health = await api("/api/health");
  console.log(`api: ${health.service} ok, rail=${health.rail?.rail ?? "?"} network=${health.rail?.network ?? "?"}`);

  const merchantVault = await api("/api/tachi/merchant-vault", { method: "POST", headers: auth, body: JSON.stringify({}) });
  console.log(`merchant vault: ${merchantVault.vaultAddress}`);

  const invoice = await api("/api/invoices", {
    method: "POST",
    body: JSON.stringify({ amountSats: DEMO_AMOUNT_SATS.toString(), memo: "SatsLoom pay-to-vault demo" }),
  });
  console.log(`invoice: ${invoice.id} (${DEMO_AMOUNT_SATS} sats)`);

  const payment = await api(`/api/tachi/invoices/${invoice.id}/pay-vault`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({}),
  });
  console.log(`payment: ${payment.id} (watching ${payment.vaultAddress})`);

  // The customer side: pay the invoice from the fund run's funding wallet.
  const jobRecord = JSON.parse(readFileSync(FUND_JOB_FILE, "utf8")) as { mnemonic: string; job: { fundingAddress: string } };
  const merchantRecord = JSON.parse(readFileSync(MERCHANT_VAULT_FILE, "utf8")) as { mnemonic: string };
  if (!jobRecord.mnemonic || !merchantRecord.mnemonic) throw new Error("Missing mnemonic in a persisted vault file; refusing to proceed");
  const adapter = new TachiSdkAdapter();
  const sourceVault = await adapter.createVault({ mnemonic: jobRecord.mnemonic });
  const targetVault = await adapter.createVault({ mnemonic: merchantRecord.mnemonic });
  if (targetVault.address !== merchantVault.vaultAddress) {
    throw new Error(`Merchant vault mismatch: derived ${targetVault.address}, API reports ${merchantVault.vaultAddress}`);
  }
  const sourceBalance = await adapter.getFundingWalletBalance(sourceVault.id);
  console.log(`source funding wallet: ${jobRecord.job.fundingAddress} (confirmed ${sourceBalance} sats)`);
  if (sourceBalance < DEMO_AMOUNT_SATS) throw new Error(`Source wallet holds ${sourceBalance} sats, less than the ${DEMO_AMOUNT_SATS}-sat invoice`);
  const deposit = await adapter.depositFromVaultToVault(sourceVault.id, targetVault.id, DEMO_AMOUNT_SATS);
  console.log(`deposit broadcast: ${deposit.txid} (${deposit.amountSats} sats)`);
  console.log(`  mempool: https://mempool.space/signet/tx/${deposit.txid}`);

  // The API watcher sees the deposit once a block confirms it, then registers.
  const deadline = Date.now() + 100 * 60_000;
  let settled: any = null;
  for (;;) {
    settled = await api(`/api/tachi/invoices/${invoice.id}/pay-vault/${payment.id}`);
    console.log(`payment: ${settled.status} · ${settled.stage}${settled.deposit ? ` · deposit ${settled.deposit.txid.slice(0, 16)}…` : ""}`);
    if (settled.status === "paid" || settled.status === "failed") break;
    if (Date.now() >= deadline) throw new Error(`Payment did not settle within 100 minutes (stage ${settled.stage})`);
    await sleep(30_000);
  }
  if (settled.status !== "paid") throw new Error(`Payment failed: ${settled.error ?? "(no error recorded)"}`);
  if (settled.deposit?.txid !== deposit.txid) {
    throw new Error(`Payment settled with a different deposit than the demo paid (settled ${settled.deposit?.txid}, demo paid ${deposit.txid})`);
  }

  // Verify the registration against the daemon, not the app's own read path.
  const registration = settled.registration;
  const txStatus = await getTachiTx(registration.broadcastHash, { baseUrl: DAEMON_RPC_URL, requestTimeoutMs: 30_000 });
  console.log(`registration: ${registration.broadcastHash} (VTXO ${registration.vtxoId}, fee ${registration.feeSats} sats)`);
  console.log(`  explorer: ${registration.explorerUrl}`);
  console.log(`  daemon: found=${txStatus.found} type=${txStatus.type} state=${txStatus.state} code=${txStatus.code} epoch=${txStatus.epoch} committed=${txStatus.committed}`);
  if (!txStatus.found || !txStatus.committed || txStatus.code !== 0) {
    throw new Error(`Registration is not committed on the daemon (found=${txStatus.found} state=${txStatus.state} code=${txStatus.code})`);
  }
  const unspent = await adapter.listUnspentVtxos(targetVault.id);
  const vtxo = unspent.find((item) => item.id === registration.vtxoId);
  if (!vtxo || vtxo.amountSats !== DEMO_AMOUNT_SATS) {
    throw new Error(`VTXO ${registration.vtxoId} not found unspent in the merchant vault (listed ${unspent.length} unspent VTXOs)`);
  }
  const invoiceAfter = await api(`/api/invoices/${invoice.id}`);
  if (invoiceAfter.status !== "confirmed" || invoiceAfter.settlement?.status !== "settled") {
    throw new Error(`Invoice is ${invoiceAfter.status} (settlement ${invoiceAfter.settlement?.status}); expected confirmed/settled`);
  }

  console.log("DEMO COMPLETE");
  console.log(JSON.stringify({
    merchantVault: merchantVault.vaultAddress,
    invoiceId: invoice.id,
    amountSats: DEMO_AMOUNT_SATS.toString(),
    depositTxid: deposit.txid,
    depositExplorerUrl: `https://mempool.space/signet/tx/${deposit.txid}`,
    registrationBroadcastHash: registration.broadcastHash,
    registrationExplorerUrl: registration.explorerUrl,
    vtxoId: registration.vtxoId,
    feeSats: registration.feeSats,
    epoch: txStatus.epoch,
    date: new Date().toISOString(),
  }, null, 2));
}

main().catch((error) => {
  console.error(`DEMO FAILED: ${describeError(error)}`);
  process.exit(1);
});
