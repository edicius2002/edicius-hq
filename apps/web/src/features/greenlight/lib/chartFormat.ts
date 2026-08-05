export function niceCeiling(value: number): number {
  const amount = Number(value) || 0;
  if (amount <= 0) return 100;
  const exp = 10 ** Math.floor(Math.log10(amount));
  const normalized = amount / exp;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * exp;
}

export function buildAxisTicks(maxValue: number, count = 4): { top: number; ticks: number[] } {
  const top = niceCeiling(maxValue);
  const ticks: number[] = [];
  for (let i = 0; i <= count; i += 1) {
    ticks.push((top * i) / count);
  }
  return { top, ticks };
}

/** Weekly chart Y scale: steps of 500 (or 1000 when the range is large). */
export function buildWeekAxisTicks(maxValue: number): { top: number; ticks: number[] } {
  const amount = Math.max(Number(maxValue) || 0, 0);
  const step = amount > 4000 ? 1000 : 500;
  const top = Math.max(step * 2, Math.ceil(amount / step) * step || step * 2);
  const ticks: number[] = [];
  for (let value = 0; value <= top + 0.001; value += step) {
    ticks.push(value);
  }
  return { top, ticks };
}

export function formatAxisMoney(value: number): string {
  const amount = Number(value) || 0;
  if (amount >= 1000) {
    const thousands = amount / 1000;
    if (Number.isInteger(thousands)) return `$${thousands}k`;
    return `$${thousands.toFixed(1)}k`;
  }
  return `$${Math.round(amount)}`;
}

/** Full dollar amount for month bars — keeps up to 5 integer digits. */
export function formatBarMoney(value: number): string {
  const amount = Math.round(Number(value) || 0);
  if (Math.abs(amount) >= 100000) return formatAxisMoney(amount);
  return `$${amount.toLocaleString('en-US')}`;
}

export function shortDate(value: string): string {
  const parts = value.split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : value;
}
