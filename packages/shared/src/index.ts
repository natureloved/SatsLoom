export type Mode = "live" | "degraded";
export type SettlementPolicy = { maxFeeSats: bigint; maxSettlementSeconds: number; feeWeight: number; latencyWeight: number; exitRiskWeight: number; liquidityPenalty: number };
export type Merchant = { id: string; name: string; settlementPolicy: SettlementPolicy };
export type Invoice = { id: string; amountSats: bigint; memo?: string; status: "created" | "pending" | "confirmed" | "failed" | "refunded"; createdAt: string; expiresAt: string };
export type LiquidityRoute = { id: string; source: "vtxo" | "liquidity_provider" | "onchain_redemption" | "simulation"; capacitySats: bigint; feeSats: bigint; estimatedSettlementSeconds: number; expiresAt: string; exitRisk: "none" | "low" | "medium" | "high"; timelockBlocks?: number; available: boolean; requiresCooperativeSigning: boolean; simulation: boolean };
export type RouteQuote = { invoiceId: string; routes: LiquidityRoute[]; quotedAt: string; quoteExpiresAt: string };
export type RouteDecision = { invoiceId: string; selectedRouteId: string; scoringInputs: { feeSats: bigint; settlementSeconds: number; exitRiskWeight: number; liquidityAvailable: bigint; expirySecondsRemaining: number }; reason: string; decidedAt: string };
export type Settlement = { id: string; invoiceId: string; routeId: string; status: "not_started" | "pending" | "settled" | "fallback" | "failed" | "refund_required"; txid?: string; vtxoId?: string; explorerUrl?: string; error?: string; simulation: boolean };
export type DaemonStatus = { reachable: boolean; network?: string; version?: string; mode: Mode };
export type Validator = { id: string; endpoint?: string; online: boolean };
export type VaultSummary = { id: string; address: string; cooperativeLeaf?: unknown; exitLeaf?: unknown; csvDelay: number };
export type VerificationResult = { valid: boolean; details?: string };
export function jsonSafe<T>(value: T): T { return JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v)); }
