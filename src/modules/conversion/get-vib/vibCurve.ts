import { badRequest } from "../../../domain/errors.js";

export interface CurveConfig {
  initialEffectiveCirculation: bigint;
  curveAllocation: bigint;
  initialMarketCapUsd: number;
  finalMarketCapUsd: number;
  segments: number;
}

export interface CurvePoint {
  sold: bigint;
  priceUsd: number;
  marketCapUsd: number;
  effectiveCirculation: bigint;
}

export interface QuoteResult {
  vibAmount: bigint;
  costUsd: number;
  averagePriceUsd: number;
  startPriceUsd: number;
  endPriceUsd: number;
  soldBefore: bigint;
  soldAfter: bigint;
}

export const TOKENOMICS = {
  TOTAL_SUPPLY: 1_000_000_000n,
  CURVE_ALLOCATION: 50_000_000n,
  TESTNET_REWARD_POOL: 30_000_000n,
  INITIAL_LIQUIDITY_RESERVE: 20_000_000n,
  MAX_EFFECTIVE_CIRCULATION_TESTNET: 100_000_000n,
} as const;

export const DEFAULT_CURVE_CONFIG: CurveConfig = {
  initialEffectiveCirculation: 50_000_000n,
  curveAllocation: TOKENOMICS.CURVE_ALLOCATION,
  initialMarketCapUsd: 500_000,
  finalMarketCapUsd: 5_000_000,
  segments: 1000,
};

export const PURCHASE_LIMITS = {
  MIN_PURCHASE_USD: 10,
  MAX_PURCHASE_USD: 10_000,
  MIN_PURCHASE_VIB: 1_000n,
  MAX_PURCHASE_VIB_PER_TX: 1_000_000n,
  MAX_PURCHASE_VIB_PER_ACCOUNT: 2_000_000n,
  SLIPPAGE_BPS_DEFAULT: 100,
} as const;

export function marketCapAtSold(sold: bigint, config: CurveConfig = DEFAULT_CURVE_CONFIG): number {
  assertSoldInRange(sold, config);
  const ratio = Number(sold) / Number(config.curveAllocation);
  return config.initialMarketCapUsd * Math.pow(config.finalMarketCapUsd / config.initialMarketCapUsd, ratio);
}

export function priceAtSold(sold: bigint, config: CurveConfig = DEFAULT_CURVE_CONFIG): number {
  return marketCapAtSold(sold, config) / Number(config.initialEffectiveCirculation + sold);
}

export function generateCurvePoints(config: CurveConfig = DEFAULT_CURVE_CONFIG): CurvePoint[] {
  const segmentSize = segmentSizeFor(config);
  const points: CurvePoint[] = [];
  for (let index = 0; index <= config.segments; index += 1) {
    const sold = index === config.segments ? config.curveAllocation : segmentSize * BigInt(index);
    points.push({
      sold,
      priceUsd: priceAtSold(sold, config),
      marketCapUsd: marketCapAtSold(sold, config),
      effectiveCirculation: config.initialEffectiveCirculation + sold,
    });
  }
  return points;
}

export function quoteBuyVib(
  soldBefore: bigint,
  vibAmount: bigint,
  config: CurveConfig = DEFAULT_CURVE_CONFIG,
): QuoteResult {
  assertSoldInRange(soldBefore, config);
  if (vibAmount <= 0n) throw badRequest("VIB amount must be positive");
  const soldAfter = soldBefore + vibAmount;
  if (soldAfter > config.curveAllocation) throw badRequest("VIB curve allocation exceeded");

  let cursor = soldBefore;
  let remaining = vibAmount;
  let costUsd = 0;
  const segmentSize = segmentSizeFor(config);

  while (remaining > 0n) {
    const segmentIndex = cursor / segmentSize;
    const segmentStart = segmentIndex * segmentSize;
    const segmentEnd = segmentIndex >= BigInt(config.segments) ? config.curveAllocation : minBigint(segmentStart + segmentSize, config.curveAllocation);
    const amountInSegment = minBigint(remaining, segmentEnd - cursor);
    const startPrice = linearPriceAt(cursor, config);
    const endPrice = linearPriceAt(cursor + amountInSegment, config);
    costUsd += Number(amountInSegment) * ((startPrice + endPrice) / 2);
    cursor += amountInSegment;
    remaining -= amountInSegment;
  }

  return {
    vibAmount,
    costUsd,
    averagePriceUsd: costUsd / Number(vibAmount),
    startPriceUsd: priceAtSold(soldBefore, config),
    endPriceUsd: priceAtSold(soldAfter, config),
    soldBefore,
    soldAfter,
  };
}

export function quoteVibFromUsd(
  soldBefore: bigint,
  budgetUsd: number,
  config: CurveConfig = DEFAULT_CURVE_CONFIG,
): QuoteResult {
  assertSoldInRange(soldBefore, config);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw badRequest("USD budget must be positive");
  let low = 0n;
  let high = config.curveAllocation - soldBefore;
  let best = 0n;

  while (low <= high) {
    const mid = (low + high) / 2n;
    if (mid === 0n) {
      low = 1n;
      continue;
    }
    const quote = quoteBuyVib(soldBefore, mid, config);
    if (quote.costUsd <= budgetUsd) {
      best = mid;
      low = mid + 1n;
    } else {
      high = mid - 1n;
    }
  }

  if (best <= 0n) throw badRequest("USD budget is too small for 1 VIB");
  return quoteBuyVib(soldBefore, best, config);
}

export function getPurchasePhase(sold: bigint): 1 | 2 | 3 {
  if (sold < 10_000_000n) return 1;
  if (sold < 30_000_000n) return 2;
  return 3;
}

export function getAccountLimitForPhase(phase: 1 | 2 | 3): bigint {
  if (phase === 1) return 100_000n;
  if (phase === 2) return 500_000n;
  return PURCHASE_LIMITS.MAX_PURCHASE_VIB_PER_ACCOUNT;
}

export function validatePurchase(params: {
  soldBefore: bigint;
  vibAmount: bigint;
  accountPurchasedTotal: bigint;
  costUsd: number;
  config?: CurveConfig;
}): void {
  const config = params.config ?? DEFAULT_CURVE_CONFIG;
  const quote = quoteBuyVib(params.soldBefore, params.vibAmount, config);
  const phase = getPurchasePhase(params.soldBefore);
  const accountLimit = getAccountLimitForPhase(phase);

  if (params.vibAmount < PURCHASE_LIMITS.MIN_PURCHASE_VIB) throw badRequest("VIB amount is below minimum", { minVib: String(PURCHASE_LIMITS.MIN_PURCHASE_VIB) });
  if (params.vibAmount > PURCHASE_LIMITS.MAX_PURCHASE_VIB_PER_TX) throw badRequest("VIB amount exceeds per-transaction maximum", { maxVib: String(PURCHASE_LIMITS.MAX_PURCHASE_VIB_PER_TX) });
  if (params.accountPurchasedTotal + params.vibAmount > accountLimit) throw badRequest("VIB account phase limit exceeded", { phase, accountLimit: String(accountLimit) });
  if (params.accountPurchasedTotal + params.vibAmount > PURCHASE_LIMITS.MAX_PURCHASE_VIB_PER_ACCOUNT) throw badRequest("VIB account total limit exceeded", { accountLimit: String(PURCHASE_LIMITS.MAX_PURCHASE_VIB_PER_ACCOUNT) });
  if (quote.costUsd < PURCHASE_LIMITS.MIN_PURCHASE_USD) throw badRequest("Purchase is below USD minimum", { minUsd: PURCHASE_LIMITS.MIN_PURCHASE_USD });
  if (quote.costUsd > PURCHASE_LIMITS.MAX_PURCHASE_USD || params.costUsd > PURCHASE_LIMITS.MAX_PURCHASE_USD) {
    throw badRequest("Purchase exceeds USD maximum", { maxUsd: PURCHASE_LIMITS.MAX_PURCHASE_USD });
  }
}

function linearPriceAt(sold: bigint, config: CurveConfig): number {
  if (sold === config.curveAllocation) return priceAtSold(sold, config);
  const segmentSize = segmentSizeFor(config);
  const segmentIndex = sold / segmentSize;
  const segmentStart = segmentIndex * segmentSize;
  const segmentEnd = minBigint(segmentStart + segmentSize, config.curveAllocation);
  const startPrice = priceAtSold(segmentStart, config);
  const endPrice = priceAtSold(segmentEnd, config);
  const ratio = Number(sold - segmentStart) / Number(segmentEnd - segmentStart);
  return startPrice + (endPrice - startPrice) * ratio;
}

function assertSoldInRange(sold: bigint, config: CurveConfig): void {
  if (sold < 0n) throw badRequest("Sold VIB cannot be negative");
  if (sold > config.curveAllocation) throw badRequest("Sold VIB exceeds curve allocation");
}

function segmentSizeFor(config: CurveConfig): bigint {
  if (!Number.isInteger(config.segments) || config.segments <= 0) throw badRequest("Curve segments must be a positive integer");
  const segmentSize = config.curveAllocation / BigInt(config.segments);
  if (segmentSize <= 0n) throw badRequest("Curve segment size must be positive");
  return segmentSize;
}

function minBigint(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
