import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentStore } from "./storage.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("PersistentStore", () => {
  it("atomically round-trips webhook URLs, idempotency records, and liquidity state", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satsloom-store-test-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "store.json");
    const store = new PersistentStore(file);
    const loaded = store.load();
    const webhookUrls = new Map([["invoice-1", "https://merchant.example/hooks"]]);
    const idempotencyRecords = new Map([[
      "checkout.session:order-001",
      { scope: "checkout.session", requestHash: "hash", response: { data: { invoiceId: "invoice-1" } }, createdAt: new Date().toISOString() },
    ]]);
    store.flush(loaded.aggregates, loaded.quotes, loaded.transactions, loaded.refunds, loaded.payouts, [], webhookUrls, idempotencyRecords, 321n);

    const restored = new PersistentStore(file).load();
    expect(restored.webhookUrls.get("invoice-1")).toBe("https://merchant.example/hooks");
    expect(restored.idempotencyRecords.get("checkout.session:order-001")).toMatchObject({ scope: "checkout.session", requestHash: "hash" });
    expect(restored.reservedLiquiditySats).toBe(321n);
    expect(fs.readdirSync(directory)).toEqual(["store.json"]);
  });
});
