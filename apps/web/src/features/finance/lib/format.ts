/**
 * Amounts are shown without a currency symbol: an asset code can be a fiat
 * currency, a crypto ticker or a stock, and only the code beside it says which.
 */
export function formatAmount(value: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatAssetAmount(asset: string, value: number): string {
  return `${asset} ${formatAmount(value)}`;
}
