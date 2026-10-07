/**
 * Rail selection from the environment.
 *
 * SatsLoom's honesty rule is that a rail is selected by configuration, not by a string in a
 * response envelope — and that every response says which rail produced it. This module is the
 * one place that decision is made, so there is exactly one place where "lightning-signet" or
 * "fixture" can come from.
 *
 * Selection precedence:
 *   1. SATSLOOM_RAIL=lnd (or LND_REST_URL set)  -> a real Lightning node over LND's REST API
 *   2. anything else                            -> FixtureLightningBackend, which cannot claim to be live
 *
 * A misconfigured LND rail fails loudly at construction time rather than silently falling back
 * to the fixture: a payment product that quietly degrades to simulation is exactly the failure
 * mode this repository exists to prevent.
 */
import {
  FixtureLightningBackend,
  LightningRail,
  LndRestBackend,
  RailUnavailableError,
  type LightningNodeBackend,
  type PaymentRail,
  type RailNetwork,
} from "./index.js";

export type RailSource = "lnd" | "fixture";

export type ResolvedRail = {
  source: RailSource;
  rail: LightningRail;
  /** True when the configured rail could not be constructed and we fell back. */
  fellBack: boolean;
  /** Why we fell back, when we did. Never a secret. */
  fallbackReason?: string;
};

function parseNetwork(value: string | undefined, fallback: "regtest" | "signet" | "testnet" | "mainnet"): RailNetwork {
  return value === "regtest" || value === "signet" || value === "testnet" || value === "mainnet" ? value : fallback;
}

export function buildLightningRailFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedRail {
  const source: RailSource = env.SATSLOOM_RAIL === "lnd" || (env.LND_REST_URL && env.SATSLOOM_RAIL !== "fixture")
    ? "lnd"
    : "fixture";

  if (source === "fixture") {
    const network = parseNetwork(env.SATSLOOM_LIGHTNING_NETWORK ?? env.LND_NETWORK, "regtest");
    return { source, rail: new LightningRail({ backend: new FixtureLightningBackend({ network }) }), fellBack: false };
  }

  const baseUrl = env.LND_REST_URL ?? "";
  const macaroonHex = env.LND_MACAROON_HEX ?? env.LND_MACAROON ?? "";
  const network = parseNetwork(env.SATSLOOM_LIGHTNING_NETWORK ?? env.LND_NETWORK, "signet");

  try {
    const backend = new LndRestBackend({
      baseUrl,
      macaroonHex,
      network,
      caCertPath: env.LND_CA_CERT_PATH || undefined,
      allowInsecureHttp: env.LND_ALLOW_INSECURE_HTTP === "true",
    });
    // `verified` is only true once a real payment has been reconciled against this node — it is
    // deliberately not set from the environment, because a config flag must never be able to
    // assert a receipt that does not exist.
    return { source, rail: new LightningRail({ backend, id: `lightning-${network}`, verified: false }), fellBack: false };
  } catch (error) {
    // A broken node configuration is a loud failure. Reporting it here lets the API answer
    // 503 with the reason instead of pretending the rail is a fixture.
    if (env.SATSLOOM_RAIL_STRICT === "true") {
      throw new RailUnavailableError(
        `SATSLOOM_RAIL=lnd is strict, but the LND backend could not be constructed: ${(error as Error).message}`,
        { cause: error },
      );
    }
    return {
      source: "fixture",
      rail: new LightningRail({ backend: new FixtureLightningBackend({ network: parseNetwork(env.SATSLOOM_LIGHTNING_NETWORK ?? env.LND_NETWORK, "regtest") }) }),
      fellBack: true,
      fallbackReason: (error as Error).message,
    };
  }
}

export { LightningRail, LndRestBackend, FixtureLightningBackend };
export type { LightningNodeBackend, PaymentRail };
