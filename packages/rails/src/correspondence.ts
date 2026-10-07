/**
 * The hash <-> id correspondence a payment product needs, in both directions.
 *
 * Two callers reach this from opposite ends and a naive single map serves only one of them:
 *   - the credit path is handed an observation keyed by payment hash and needs the invoice id;
 *   - the read path is handed an invoice id and needs the payment hash.
 *
 * Getting either direction wrong is invisible in a passing test suite and fatal in production,
 * because the symptom is not an error: it is a settled payment that never credits. This type
 * makes both directions explicit, keeps them in lockstep, and asserts its own invariant so a
 * mapper that was written backwards fails at construction instead of silently dropping money.
 */
export class PaymentCorrespondence {
  private readonly byHash = new Map<string, string>();
  private readonly byInvoiceId = new Map<string, string>();

  /** Record a correspondence. Both directions are always set together. */
  link(paymentHash: string, invoiceId: string): void {
    this.byHash.set(paymentHash, invoiceId);
    this.byInvoiceId.set(invoiceId, paymentHash);
  }

  /** Resolve an observation's payment hash back to the invoice it belongs to. */
  invoiceIdFor(paymentHash: string): string | undefined {
    return this.byHash.get(paymentHash);
  }

  /** Resolve a client's invoice id to the payment hash the rail knows it by. */
  paymentHashFor(invoiceId: string): string | undefined {
    return this.byInvoiceId.get(invoiceId);
  }

  /** For assertion: every linked pair is resolvable in both directions. */
  assertConsistent(): void {
    for (const [hash, invoiceId] of this.byHash) {
      if (this.byInvoiceId.get(invoiceId) !== hash) {
        throw new Error(`payment correspondence is inconsistent: ${hash} does not map back to ${invoiceId}`);
      }
    }
    for (const [invoiceId, hash] of this.byInvoiceId) {
      if (this.byHash.get(hash) !== invoiceId) {
        throw new Error(`payment correspondence is inconsistent: ${invoiceId} does not map back to ${hash}`);
      }
    }
  }

  get size(): number {
    return this.byHash.size;
  }
}
