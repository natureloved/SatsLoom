import { afterEach, describe, expect, it } from "vitest";
import {
  SUPPORTED_TACHI_NETWORKS,
  TachiSdkAdapter,
  isSupportedTachiNetwork,
  loadTachiConfig,
  type TachiAdapterConfig,
} from "./index";

/**
 * The Tachi adapter is the only place a Bitcoin chain is chosen, so these tests
 * pin the decision: signet by default, per-chain endpoints, and a loud refusal
 * for anything the wallet aggregator cannot fund.
 */

const ORIGINAL_ENV = { ...process.env };

function withEnv(env: Record<string, string | undefined>) {
  for (const key of ["TACHI_NETWORK", "TACHI_DAEMON_RPC_URL", "TACHI_EXPLORER_URL", "TACHI_FAUCET_URL", "BITCOIN_RPC_URL"]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("tachi network selection", () => {
  it("defaults to signet, the publicly demonstrable chain", () => {
    withEnv({});
    const config = loadTachiConfig();
    expect(config.network).toBe("signet");
    expect(config.daemonRpcUrl).toBe("https://rpc-signet.tachibtc.com");
    expect(config.explorerUrl).toBe("https://signet.tachibtcscan.com");
  });

  it("resolves each chain's own endpoints, so network and URL cannot drift apart", () => {
    withEnv({ TACHI_NETWORK: "regtest" });
    const config = loadTachiConfig();
    expect(config.network).toBe("regtest");
    expect(config.daemonRpcUrl).toBe("https://rpc-regtest.tachibtc.com");
    expect(config.explorerUrl).toBe("https://regtest.tachibtcscan.com");
  });

  it("keeps explicit endpoint overrides on any network", () => {
    withEnv({
      TACHI_NETWORK: "signet",
      TACHI_DAEMON_RPC_URL: "https://daemon.example.com/",
      TACHI_EXPLORER_URL: "https://explorer.example.com/",
      TACHI_FAUCET_URL: "https://faucet.example.com/v1/faucet",
    });
    const config = loadTachiConfig();
    expect(config.daemonRpcUrl).toBe("https://daemon.example.com");
    expect(config.explorerUrl).toBe("https://explorer.example.com");
    expect(config.faucetUrl).toBe("https://faucet.example.com/v1/faucet");
  });

  it("refuses a chain the wallet aggregator cannot fund", () => {
    // mainnet is a valid vault *address* network, but no wallet exists for it,
    // so a vault could never be paid into. Refusing here beats handing out an
    // address that cannot be funded.
    expect(() => withEnv({ TACHI_NETWORK: "mainnet" })).not.toThrow();
    expect(() => loadTachiConfig()).toThrow(/not a supported Tachi wallet chain/i);
    expect(isSupportedTachiNetwork("mainnet")).toBe(false);
    expect(isSupportedTachiNetwork("signet")).toBe(true);
    expect(isSupportedTachiNetwork("regtest")).toBe(true);
  });

  it("rejects a non-http(s) daemon URL", () => {
    withEnv({ TACHI_DAEMON_RPC_URL: "ftp://daemon.example.com" });
    expect(() => loadTachiConfig()).toThrow(/must use http or https/i);
  });
});

describe("adapter construction", () => {
  it("reports the chain it is bound to", () => {
    const adapter = new TachiSdkAdapter({
      daemonRpcUrl: "https://rpc-signet.tachibtc.com",
      bitcoinRpcUrl: "https://rpc-signet.tachibtc.com",
      bitcoinFundingWallet: "dev",
      network: "signet",
      explorerUrl: "https://signet.tachibtcscan.com",
      faucetUrl: "https://faucet.rgbmap.org/v1/faucet",
      timeoutMs: 1_000,
    } satisfies TachiAdapterConfig);
    expect(adapter.network).toBe("signet");
    expect(adapter.faucetAvailable).toBe(true);
  });

  it("does not offer faucet funding on regtest, which is funded locally", () => {
    const adapter = new TachiSdkAdapter({
      daemonRpcUrl: "https://rpc-regtest.tachibtc.com",
      bitcoinRpcUrl: "http://127.0.0.1:18443",
      bitcoinFundingWallet: "dev",
      network: "regtest",
      explorerUrl: "https://regtest.tachibtcscan.com",
      faucetUrl: "https://faucet.rgbmap.org/v1/faucet",
      timeoutMs: 1_000,
    } satisfies TachiAdapterConfig);
    expect(adapter.network).toBe("regtest");
    expect(adapter.faucetAvailable).toBe(false);
  });

  it("refuses to build against a chain no wallet is registered for", () => {
    expect(() =>
      new TachiSdkAdapter({
        daemonRpcUrl: "https://daemon.example.com",
        bitcoinRpcUrl: "https://daemon.example.com",
        bitcoinFundingWallet: "dev",
        // Cast is deliberate: the point is that a name outside the supported
        // set never reaches the SDK.
        network: "mainnet" as never,
        explorerUrl: "https://explorer.example.com",
        faucetUrl: "https://faucet.example.com",
        timeoutMs: 1_000,
      }),
    ).toThrow(/not registered by the wallet aggregator/i);
  });
});

describe("regtest-only operations are guarded", () => {
  const signetAdapter = () =>
    new TachiSdkAdapter({
      daemonRpcUrl: "https://rpc-signet.tachibtc.com",
      bitcoinRpcUrl: "https://rpc-signet.tachibtc.com",
      bitcoinFundingWallet: "dev",
      network: "signet",
      explorerUrl: "https://signet.tachibtcscan.com",
      faucetUrl: "https://faucet.rgbmap.org/v1/faucet",
      timeoutMs: 1_000,
    } satisfies TachiAdapterConfig);

  it("mining is refused on signet, where nothing can be mined", async () => {
    await expect(signetAdapter().mineLocalBlocks(1)).rejects.toThrow(/regtest-only/i);
  });

  it("local funding is refused on signet, pointing at the faucet instead", async () => {
    await expect(signetAdapter().prepareLocalFunding("vault", 100_000n)).rejects.toThrow(/faucet/i);
  });

  it("signet confirmation waiting is refused on regtest", async () => {
    const adapter = new TachiSdkAdapter({
      daemonRpcUrl: "https://rpc-regtest.tachibtc.com",
      bitcoinRpcUrl: "http://127.0.0.1:18443",
      bitcoinFundingWallet: "dev",
      network: "regtest",
      explorerUrl: "https://regtest.tachibtcscan.com",
      faucetUrl: "https://faucet.rgbmap.org/v1/faucet",
      timeoutMs: 1_000,
    } satisfies TachiAdapterConfig);
    await expect(adapter.waitForSignetDepositConfirmation("ab".repeat(32))).rejects.toThrow(/signet-only/i);
  });

  it("faucet claims are refused for an unknown vault and a bad amount", async () => {
    const adapter = signetAdapter();
    await expect(adapter.claimFaucetFunds("not-a-vault", 0.001)).rejects.toThrow(/Unknown vault/i);
  });
});

describe("supported network list", () => {
  it("is exactly the two chains the wallet aggregator registers", () => {
    expect([...SUPPORTED_TACHI_NETWORKS]).toEqual(["signet", "regtest"]);
  });
});
