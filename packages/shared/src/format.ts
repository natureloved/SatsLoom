/**
 * Display helpers shared by the API and the web app.
 *
 * These exist so the "timelock abstraction" is one implementation rather than a rule each
 * screen re-invents: users see `instant` / `~4 min`, and raw CSV block counts only appear
 * in the Advanced view.
 */

/** Regtest targets ~10 minutes per block, same as Bitcoin mainnet's target spacing. */
export const BLOCK_SECONDS = 600;

export function satsToBtcString(sats: bigint): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function formatSats(sats: bigint): string {
  return `${groupDigits(sats.toString())} sats`;
}

export function groupDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `instant` under a minute, then `~N min`, then `~N h`. Never shows a raw block count. */
export function friendlyDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 60) return "instant";
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `~${(seconds / 3600).toFixed(1).replace(/\.0$/, "")} h`;
  return `~${(seconds / 86_400).toFixed(1).replace(/\.0$/, "")} d`;
}

/** Seconds implied by a relative-timelock block count (CSV), at the target block spacing. */
export function blocksToSeconds(blocks: number, blockSeconds = BLOCK_SECONDS): number {
  return blocks * blockSeconds;
}

export type TimelockView = {
  /** The only form ordinary users see: `instant`, `~20 min`, `~4.2 h`. */
  friendly: string;
  /** The Advanced-view form: the raw consensus value plus its source. */
  advanced: string;
};

/**
 * Renders one route's timing. `timelockBlocks` is a CSV relative timelock (unilateral exit);
 * routes without one settle inside the quorum's cooperative window.
 */
export function describeTimelock(route: { estimatedSettlementSeconds: number; timelockBlocks?: number }): TimelockView {
  const friendly = friendlyDuration(route.estimatedSettlementSeconds);
  if (!route.timelockBlocks) {
    return { friendly, advanced: `cooperative, no CSV · ${route.estimatedSettlementSeconds}s estimate` };
  }
  const blocks = route.timelockBlocks;
  const secs = blocksToSeconds(blocks);
  return {
    friendly: `${friendly} (after a ${friendlyDuration(secs)} CSV)`,
    advanced: `BIP-68 relative timelock: ${blocks} blocks (~${friendlyDuration(secs)})`,
  };
}

export function timeAgo(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

export function countdown(untilIso: string, now = Date.now()): { secondsRemaining: number; label: string; expired: boolean } {
  const until = Date.parse(untilIso);
  const secondsRemaining = Number.isNaN(until) ? 0 : Math.max(0, Math.floor((until - now) / 1000));
  const expired = secondsRemaining <= 0 || Number.isNaN(until);
  if (expired) return { secondsRemaining: 0, label: "expired", expired: true };
  const m = Math.floor(secondsRemaining / 60);
  const s = secondsRemaining % 60;
  if (m >= 60) return { secondsRemaining, label: `${Math.floor(m / 60)}h ${m % 60}m`, expired: false };
  return { secondsRemaining, label: `${m}:${String(s).padStart(2, "0")}`, expired: false };
}

/** Explains a route's exit risk in plain language, for the transparency table's tooltip. */
export function exitRiskExplanation(risk: "none" | "low" | "medium" | "high"): string {
  switch (risk) {
    case "none":
      return "Self-custody ledger route. The funds are already yours; no third party has to stay honest for you to keep them.";
    case "low":
      return "A liquidity provider co-signs. If they stop responding, your fallback is the on-chain exit, which costs time.";
    case "medium":
      return "Depends on a cooperative signature to settle at the quoted speed. Fallback requires an on-chain exit.";
    case "high":
      return "Settles on the base chain. You wait for blocks and pay a network fee, but nothing can censor it.";
  }
}
