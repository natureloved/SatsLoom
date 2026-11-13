import { afterEach, describe, expect, it } from "vitest";
import { app } from "./server.js";
import {
  continueTachiFundJob,
  getTachiFundJob,
  setTachiFundAdapterFactory,
  startTachiFundJob,
  type TachiAdapter,
  type TachiFundJob,
} from "./tachi-fund.js";

afterEach(() => {
  setTachiFundAdapterFactory(null);
  delete process.env.SATSLOOM_TACHI_FUND_ENABLED;
});

/** Waits until the job reaches a terminal status, then returns it. */
async function waitForJob(id: string, timeoutMs = 5_000): Promise<TachiFundJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getTachiFundJob(id);
    if (!job) throw new Error(`job ${id} disappeared`);
    if (job.status === "complete" || job.status === "failed" || job.status === "awaiting-manual-funding") return job;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not finish in ${timeoutMs}ms (stage ${job.stage})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type StubOptions = {
  claim?: { txid: string; sats: bigint } | null | Error;
  balance?: bigint;
  deposit?: { txid: string; amountSats: bigint };
  register?: { broadcastHash: string; vtxoId: string; feeSats: bigint };
  depositError?: Error;
};

function stubAdapter(options: StubOptions = {}): TachiAdapter {
  // Note: `??` would turn an explicit `claim: null` (faucet declined) into the
  // default success — the null is the case under test, so check presence.
  const claim = "claim" in options ? options.claim : { txid: "a".repeat(64), sats: 50_000n };
  const calls: string[] = [];
  const stub = {
    network: "signet",
    calls,
    getExplorerUrl: (txid: string) => `https://signet.tachibtcscan.com/tx/${txid}`,
    createVault: async () => {
      calls.push("createVault");
      return { id: "tb1p_stub_vault", address: "tb1p_stub_vault", csvDelay: 1008 };
    },
    getFundingAddress: () => "tb1q_stub_funding_wallet",
    getFundingWalletBalance: async () => options.balance ?? 50_000n,
    claimFaucetFunds: async () => {
      calls.push("claimFaucetFunds");
      if (claim instanceof Error) throw claim;
      return claim;
    },
    depositToVault: async () => {
      calls.push("depositToVault");
      if (options.depositError) throw options.depositError;
      return options.deposit ?? { txid: "b".repeat(64), amountSats: 48_719n };
    },
    registerDeposit: async () => {
      calls.push("registerDeposit");
      const reg = options.register ?? { broadcastHash: "c".repeat(64), vtxoId: "d".repeat(64), feeSats: 1_000n };
      return { broadcastHash: reg.broadcastHash, vtxoId: reg.vtxoId, vtxo: { id: reg.vtxoId }, feeSats: reg.feeSats };
    },
  };
  return stub as unknown as TachiAdapter;
}

describe("Tachi vault fund flow", () => {
  it("refuses to start when the flow is not enabled", async () => {
    const res = await app.inject({ method: "POST", url: "/api/tachi/vault/fund", payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("SATSLOOM_TACHI_FUND_ENABLED=true");
  });

  it("returns 404 for an unknown fund job", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tachi/vault/fund/no-such-job" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an invalid deposit amount", async () => {
    process.env.SATSLOOM_TACHI_FUND_ENABLED = "true";
    const res = await app.inject({ method: "POST", url: "/api/tachi/vault/fund", payload: { depositSats: "0" } });
    expect(res.statusCode).toBe(400);
  });

  it("runs vault → faucet → deposit → register and records every transaction with an explorer link", async () => {
    process.env.SATSLOOM_TACHI_FUND_ENABLED = "true";
    const adapter = stubAdapter();
    setTachiFundAdapterFactory(() => adapter);
    const started = await app.inject({ method: "POST", url: "/api/tachi/vault/fund", payload: { depositSats: "100000" } });
    expect(started.statusCode).toBe(202);
    const jobId = started.json().data.id as string;
    const job = await waitForJob(jobId);
    expect(job.status).toBe("complete");
    expect(job.stage).toBe("complete");
    expect(job.vaultAddress).toBe("tb1p_stub_vault");
    expect(job.faucet?.txid).toBe("a".repeat(64));
    expect(job.faucet?.explorerUrl).toBe(`https://signet.tachibtcscan.com/tx/${"a".repeat(64)}`);
    expect(job.deposit?.txid).toBe("b".repeat(64));
    expect(job.deposit?.amountSats).toBe("48719");
    expect(job.registration?.vtxoId).toBe("d".repeat(64));
    expect(job.registration?.explorerUrl).toBe(`https://signet.tachibtcscan.com/tx/${"c".repeat(64)}`);
    expect(job.error).toBeNull();
    // The mnemonic is generated inside the runner and never surfaces on the job.
    expect(JSON.stringify(job)).not.toContain("mnemonic");
  });

  it("waits for manual funding when the faucet declines, then continues to completion", async () => {
    process.env.SATSLOOM_TACHI_FUND_ENABLED = "true";
    setTachiFundAdapterFactory(() => stubAdapter({ claim: null }));
    const started = await app.inject({ method: "POST", url: "/api/tachi/vault/fund", payload: {} });
    const jobId = started.json().data.id as string;
    const waiting = await waitForJob(jobId);
    expect(waiting.status).toBe("awaiting-manual-funding");
    expect(waiting.fundingAddress).toBe("tb1q_stub_funding_wallet");
    expect(waiting.error).toContain("faucet declined");
    expect(waiting.deposit).toBeNull();
    expect(waiting.registration).toBeNull();

    const continued = await app.inject({ method: "POST", url: `/api/tachi/vault/fund/${jobId}/continue`, payload: {} });
    expect(continued.statusCode).toBe(202);
    const done = await waitForJob(jobId);
    expect(done.status).toBe("complete");
    expect(done.registration?.vtxoId).toBe("d".repeat(64));
  });

  it("records a hung faucet verbatim and waits for manual funding instead of faking a claim", async () => {
    process.env.SATSLOOM_TACHI_FUND_ENABLED = "true";
    const hang = new Error("The operation was aborted");
    hang.name = "AbortError";
    setTachiFundAdapterFactory(() => stubAdapter({ claim: hang }));
    const job = startTachiFundJob(100_000n);
    const waiting = await waitForJob(job.id);
    expect(waiting.status).toBe("awaiting-manual-funding");
    expect(waiting.error).toBe("The operation was aborted");
    expect(waiting.faucet).toBeNull();
  });

  it("records a deposit failure verbatim and never registers a VTXO", async () => {
    process.env.SATSLOOM_TACHI_FUND_ENABLED = "true";
    const adapter = stubAdapter({ depositError: new Error("daemon rejected deposit: fee below minimum") });
    setTachiFundAdapterFactory(() => adapter);
    const job = startTachiFundJob(100_000n);
    const failed = await waitForJob(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.stage).toBe("failed");
    expect(failed.error).toBe("daemon rejected deposit: fee below minimum");
    expect(failed.registration).toBeNull();
    expect((adapter as unknown as { calls: string[] }).calls).not.toContain("registerDeposit");
  });

  it("refuses to continue a job that is not awaiting manual funding", async () => {
    process.env.SATSLOOM_TACHI_FUND_ENABLED = "true";
    setTachiFundAdapterFactory(() => stubAdapter());
    const started = await app.inject({ method: "POST", url: "/api/tachi/vault/fund", payload: {} });
    const jobId = started.json().data.id as string;
    await waitForJob(jobId);
    const res = await app.inject({ method: "POST", url: `/api/tachi/vault/fund/${jobId}/continue`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(() => continueTachiFundJob("no-such-job")).not.toThrow();
    expect(continueTachiFundJob("no-such-job")).toBeNull();
  });
});
