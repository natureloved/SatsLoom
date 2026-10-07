/**
 * Invoice watching, so a payment is detected without anybody pressing a button.
 *
 * The fixture path can settle synchronously because it lives in the same process. A real node
 * cannot: the payer's wallet settles the HTLC whenever it settles, and our job is to notice.
 * This poller is the smallest thing that does that correctly, and it is deliberately
 * conservative about what it does with what it sees — it never credits, it only reports.
 *
 * Properties the live product needs, and how this satisfies them:
 *   - no double credit: every observation keyed by payment hash, and credit is a pure function
 *     of (request, observation) plus a single-claim registry (see packages/rails CreditRegistry);
 *   - no missed payment: a poll that fails is retried with backoff, and a miss that spans a
 *     restart is backfilled by `lookup` on the node, which still remembers the invoice;
 *   - no false positive: an invoice that has not settled is reported as pending forever, and
 *     only a preimage that hashes to the committed payment hash can ever produce a verdict of
 *     "paid" (verifyPayment() fails closed on a missing or wrong preimage).
 */
import { EventEmitter } from "node:events";
import type { PaymentObservation, PaymentRail } from "./index.js";

export type WatchTarget = {
  /** The rail's identifier: the payment hash for Lightning. */
  railRequestId: string;
  /** Stop watching after this unix time, and report the invoice as expired. */
  expiresAt: number;
  /** Optional label for logs. */
  invoiceId?: string;
};

export type WatcherOptions = {
  rail: PaymentRail;
  intervalMs?: number;
  maxIntervalMs?: number;
  /** Called for every state change observed. Never throws (a bad listener must not kill the poller). */
  onChange: (observation: PaymentObservation) => void | Promise<void>;
  onError?: (error: Error, context: { railRequestId: string; consecutiveFailures: number }) => void;
};

/** States that end a watch: once seen, there is nothing left to poll for. */
const TERMINAL: ReadonlySet<string> = new Set(["paid", "cancelled", "expired"]);

export class InvoiceWatcher extends EventEmitter {
  private readonly rail: PaymentRail;
  private readonly targets = new Map<string, WatchTarget>();
  private readonly seen = new Map<string, string>();
  private readonly onChange: (observation: PaymentObservation) => void | Promise<void>;
  private readonly onError?: (error: Error, context: { railRequestId: string; consecutiveFailures: number }) => void;
  private readonly baseIntervalMs: number;
  private readonly maxIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private stopped = true;
  /** Consecutive errors for the currently failing target; drives exponential backoff. */
  private targetFailures = new Map<string, number>();

  constructor(options: WatcherOptions) {
    super();
    this.rail = options.rail;
    this.baseIntervalMs = Math.max(250, options.intervalMs ?? 2_000);
    this.maxIntervalMs = Math.max(this.baseIntervalMs, options.maxIntervalMs ?? 30_000);
    this.onChange = options.onChange;
    this.onError = options.onError;
  }

  /** Add or refresh a target. Adding an expired invoice reports it as expired once. */
  watch(target: WatchTarget): void {
    this.targets.set(target.railRequestId.toLowerCase(), target);
    this.start();
  }

  unwatch(railRequestId: string): void {
    this.targets.delete(railRequestId.toLowerCase());
    this.seen.delete(railRequestId.toLowerCase());
    this.targetFailures.delete(railRequestId.toLowerCase());
  }

  get watching(): string[] {
    return [...this.targets.keys()];
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Poll every target once now. Exposed for tests and for one-shot backfills. */
  async pollOnce(): Promise<void> {
    for (const target of [...this.targets.values()]) {
      await this.pollTarget(target);
    }
  }

  private async pollTarget(target: WatchTarget): Promise<void> {
    const key = target.railRequestId.toLowerCase();
    if (Math.floor(Date.now() / 1000) > target.expiresAt) {
      // An invoice older than its expiry will never be paid, so watching it is a resource leak.
      // The credit path would refuse it anyway; say so once and stop.
      if (this.seen.get(key) !== "expired") {
        this.seen.set(key, "expired");
        await this.emitChange({
          railRequestId: key,
          paymentHash: key,
          state: "expired",
        });
      }
      this.unwatch(key);
      return;
    }

    try {
      const observation = await this.rail.observe(key);
      this.failures = 0;
      this.targetFailures.delete(key);
      const previous = this.seen.get(key);
      const isReportable = observation.state === "paid" || observation.state === "cancelled" || observation.state === "expired";
      if (isReportable) {
        this.seen.set(key, observation.state);
        this.unwatch(key);
        await this.emitChange(observation);
      } else {
        // Track non-terminal state silently so a later transition can be detected, without
        // turning every "still pending" poll into an event.
        this.seen.set(key, observation.state);
      }
    } catch (error) {
      this.failures += 1;
      const consecutive = (this.targetFailures.get(key) ?? 0) + 1;
      this.targetFailures.set(key, consecutive);
      this.onError?.(error as Error, { railRequestId: key, consecutiveFailures: consecutive });
      // Exponential backoff, capped: a node that is down must not turn into a request storm.
      if (consecutive % 5 === 1) {
        process.emitWarning?.(
          `SatsLoom invoice watcher: ${consecutive} consecutive failure(s) observing ${key.slice(0, 12)}…`,
        );
      }
    }
  }

  private async emitChange(observation: PaymentObservation): Promise<void> {
    // A listener that throws must not take the poller down with it: the observation is already
    // recorded by the credit path, and losing the poll loop would lose the *next* payment.
    try {
      await this.onChange(observation);
    } catch (error) {
      this.onError?.(error as Error, { railRequestId: observation.railRequestId, consecutiveFailures: 0 });
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    await this.pollOnce();
    if (this.stopped) return;
    const failures = Math.max(this.failures, ...this.targetFailures.values());
    const delay = Math.min(this.maxIntervalMs, this.baseIntervalMs * 2 ** Math.min(failures, 5));
    this.timer = setTimeout(() => void this.tick(), delay);
  }
}
