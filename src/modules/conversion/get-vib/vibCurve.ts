import { badRequest } from "../../../domain/errors.js";

export interface CurveConfig {
  initialEffectiveCirculation: bigint;
  curveAllocation: bigint;
  initialMarketCapDot: number;
  finalMarketCapDot: number;
  segments: number;
}

export interface CurvePoint {
  sold: bigint;
  priceDot: number;
  marketCapDot: number;
  effectiveCirculation: bigint;
}

export interface QuoteResult {
  vibAmount: bigint;
  costDot: number;
  averagePriceDot: number;
  startPriceDot: number;
  endPriceDot: number;
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
  initialMarketCapDot: 500_000 / 10.98,
  finalMarketCapDot: 5_000_000 / 10.98,
  segments: 1000,
};

/** 1 VIB = 10^12 base units (12 decimal places, matches on-chain UNIT_DECIMALS) */
export const VIB_SCALE = 10n ** 12n;

export const PURCHASE_LIMITS = {
  MIN_PURCHASE_DOT: 10 / 10.98,
  MIN_PURCHASE_VIB: 1_000n,
  MAX_PURCHASE_VIB_PER_TX: 1_000_000n,
  MAX_PURCHASE_VIB_PER_ACCOUNT: 2_000_000n,
  SLIPPAGE_BPS_DEFAULT: 100,
} as const;

export function marketCapDotAtSold(sold: bigint, config: CurveConfig = DEFAULT_CURVE_CONFIG): number {
  assertSoldInRange(sold, config);
  const ratio = Number(sold) / Number(config.curveAllocation);
  return config.initialMarketCapDot * Math.pow(config.finalMarketCapDot / config.initialMarketCapDot, ratio);
}

export function priceAtSold(sold: bigint, config: CurveConfig = DEFAULT_CURVE_CONFIG): number {
  return marketCapDotAtSold(sold, config) / Number(config.initialEffectiveCirculation + sold);
}

export function generateCurvePoints(config: CurveConfig = DEFAULT_CURVE_CONFIG): CurvePoint[] {
  const segmentSize = segmentSizeFor(config);
  const points: CurvePoint[] = [];
  for (let index = 0; index <= config.segments; index += 1) {
    const sold = index === config.segments ? config.curveAllocation : segmentSize * BigInt(index);
    points.push({
      sold,
      priceDot: priceAtSold(sold, config),
      marketCapDot: marketCapDotAtSold(sold, config),
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
  let costDot = 0;
  const segmentSize = segmentSizeFor(config);

  while (remaining > 0n) {
    const segmentIndex = cursor / segmentSize;
    const segmentStart = segmentIndex * segmentSize;
    const segmentEnd = segmentIndex >= BigInt(config.segments) ? config.curveAllocation : minBigint(segmentStart + segmentSize, config.curveAllocation);
    const amountInSegment = minBigint(remaining, segmentEnd - cursor);
    const startPrice = linearPriceAt(cursor, config);
    const endPrice = linearPriceAt(cursor + amountInSegment, config);
    costDot += Number(amountInSegment) * ((startPrice + endPrice) / 2);
    cursor += amountInSegment;
    remaining -= amountInSegment;
  }

  return {
    vibAmount: vibAmount * VIB_SCALE,
    costDot,
    averagePriceDot: costDot / Number(vibAmount),
    startPriceDot: priceAtSold(soldBefore, config),
    endPriceDot: priceAtSold(soldAfter, config),
    soldBefore,
    soldAfter,
  };
}

export function quoteVibFromDot(
  soldBefore: bigint,
  budgetDot: number,
  config: CurveConfig = DEFAULT_CURVE_CONFIG,
): QuoteResult {
  assertSoldInRange(soldBefore, config);
  if (soldBefore >= config.curveAllocation) throw badRequest("VIB curve allocation is fully sold out");
  if (!Number.isFinite(budgetDot) || budgetDot <= 0) throw badRequest("DOT budget must be positive");

  // Phase 1: binary search over whole VIBs
  let low = 0n;
  let high = config.curveAllocation - soldBefore;
  let bestWholeVibs = 0n;
  while (low <= high) {
    const mid = (low + high) / 2n;
    if (mid === 0n) {
      low = 1n;
      continue;
    }
    if (quoteBuyVib(soldBefore, mid, config).costDot <= budgetDot) {
      bestWholeVibs = mid;
      low = mid + 1n;
    } else {
      high = mid - 1n;
    }
  }

  // Phase 2: binary search over fractional base units within remaining budget
  const wholeCostDot = bestWholeVibs > 0n ? quoteBuyVib(soldBefore, bestWholeVibs, config).costDot : 0;
  let bestFrac = 0n;
  if (soldBefore + bestWholeVibs < config.curveAllocation) {
    const pricePerWholeVib = linearPriceAt(soldBefore + bestWholeVibs, config);
    let fLow = 1n;
    let fHigh = VIB_SCALE - 1n;
    while (fLow <= fHigh) {
      const fMid = (fLow + fHigh) / 2n;
      if (wholeCostDot + (Number(fMid) / Number(VIB_SCALE)) * pricePerWholeVib <= budgetDot) {
        bestFrac = fMid;
        fLow = fMid + 1n;
      } else {
        fHigh = fMid - 1n;
      }
    }
  }

  const totalBaseUnits = bestWholeVibs * VIB_SCALE + bestFrac;
  if (totalBaseUnits <= 0n) throw badRequest("DOT budget is too small for 1 VIB");

  const fracCostDot = (Number(bestFrac) / Number(VIB_SCALE)) * linearPriceAt(soldBefore + bestWholeVibs, config);
  const totalCostDot = wholeCostDot + fracCostDot;
  const totalVib = Number(bestWholeVibs) + Number(bestFrac) / Number(VIB_SCALE);
  return {
    vibAmount: totalBaseUnits,
    costDot: totalCostDot,
    averagePriceDot: totalCostDot / totalVib,
    startPriceDot: priceAtSold(soldBefore, config),
    endPriceDot: linearPriceAt(soldBefore + bestWholeVibs, config),
    soldBefore,
    soldAfter: soldBefore + bestWholeVibs,
  };
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
  costDot: number;
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
  if (quote.costDot < PURCHASE_LIMITS.MIN_PURCHASE_DOT) throw badRequest("Purchase is below DOT minimum", { minDot: PURCHASE_LIMITS.MIN_PURCHASE_DOT });
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
