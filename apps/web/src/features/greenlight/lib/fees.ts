/** AnyoneAI platform fee on deliverable gross amounts (legacy Greenlight contract). */
export const PLATFORM_FEE_RATE = 0.1;

/** Gross at or above this is charged the fee; below it nothing is deducted. */
export const PLATFORM_FEE_MIN_GROSS = 1000;

export type FeeBreakdown = {
  gross: number;
  fee: number;
  net: number;
  /** Rate actually applied — 0 when the gross is under the threshold. */
  feeRate: number;
  charged: boolean;
};

export function applyPlatformFee(gross: number, feeRate = PLATFORM_FEE_RATE): FeeBreakdown {
  const safeGross = Number(gross) || 0;
  const charged = safeGross >= PLATFORM_FEE_MIN_GROSS;
  const fee = charged ? safeGross * feeRate : 0;
  return {
    gross: safeGross,
    fee,
    net: safeGross - fee,
    feeRate: charged ? feeRate : 0,
    charged,
  };
}
