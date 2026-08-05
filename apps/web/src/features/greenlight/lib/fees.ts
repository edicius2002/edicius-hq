/** AnyoneAI platform fee on deliverable gross amounts (legacy Greenlight contract). */
export const PLATFORM_FEE_RATE = 0.1;

export type FeeBreakdown = {
  gross: number;
  fee: number;
  net: number;
  feeRate: number;
};

export function applyPlatformFee(gross: number, feeRate = PLATFORM_FEE_RATE): FeeBreakdown {
  const safeGross = Number(gross) || 0;
  const fee = safeGross * feeRate;
  return {
    gross: safeGross,
    fee,
    net: safeGross - fee,
    feeRate,
  };
}
