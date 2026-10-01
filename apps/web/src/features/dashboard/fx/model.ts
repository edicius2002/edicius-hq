import { isSource, isRange, isReference, type Source } from './sources';
import type { Observation, History, Preferences } from './types';
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function observation(value: unknown): Observation {
  if (
    !object(value) ||
    typeof value.owner_id !== 'string' ||
    !value.owner_id ||
    !isSource(value.source) ||
    !timestamp(value.observed_at) ||
    !timestamp(value.effective_at) ||
    typeof value.buy !== 'number' ||
    typeof value.sell !== 'number' ||
    !Number.isFinite(value.buy) ||
    !Number.isFinite(value.sell) ||
    value.buy <= 0 ||
    value.sell < value.buy ||
    !object(value.context) ||
    Object.keys(value.context).some(
      (key) => !['variant', 'method', 'amount_usd', 'direction', 'via', 'series'].includes(key),
    )
  )
    throw new Error('Invalid FX observation');
  return {
    owner_id: value.owner_id,
    source: value.source,
    observed_at: value.observed_at,
    effective_at: value.effective_at,
    buy: value.buy,
    sell: value.sell,
    context: value.context,
  };
}
export function parseLatest(value: unknown): Observation[] {
  if (!Array.isArray(value)) throw new Error('Invalid FX latest response');
  const rows = value.map(observation);
  if (new Set(rows.map((row) => row.source)).size !== rows.length)
    throw new Error('Duplicate FX source');
  return rows;
}
export function parseHistory(value: unknown, source: Source): History {
  if (
    !object(value) ||
    !Array.isArray(value.points) ||
    (value.aggregation !== 'daily' && value.aggregation !== 'observations')
  )
    throw new Error('Invalid FX history');
  const points = value.points.map(observation);
  if (
    points.some(
      (point, index) =>
        point.source !== source ||
        (index > 0 && Date.parse(point.effective_at) <= Date.parse(points[index - 1].effective_at)),
    )
  )
    throw new Error('Invalid FX history order or source');
  return { points, aggregation: value.aggregation };
}
export function freshness(row: Observation, now: number): 'Fresh' | 'Stale' {
  const captured = now - Date.parse(row.observed_at);
  const effective = now - Date.parse(row.effective_at);
  return captured < 0 ||
    effective < 0 ||
    captured > (isReference(row.source) ? 12 * 60 : 45) * 60_000 ||
    (isReference(row.source) && effective > 7 * 86400_000)
    ? 'Stale'
    : 'Fresh';
}
export function bestQuotes(rows: Observation[], now: number) {
  const fresh = rows.filter((row) => !isReference(row.source) && freshness(row, now) === 'Fresh');
  return {
    buy: fresh.length ? Math.max(...fresh.map((row) => row.buy)) : undefined,
    sell: fresh.length ? Math.min(...fresh.map((row) => row.sell)) : undefined,
  };
}
export function readPreferences(raw: string | null): Preferences {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? '{}');
  } catch {
    value = {};
  }
  const data = object(value) ? value : {};
  return {
    source: isSource(data.source) ? data.source : 'kambista',
    range: isRange(data.range) ? data.range : '7D',
    favorites: Array.isArray(data.favorites) ? [...new Set(data.favorites.filter(isSource))] : [],
  };
}
export const price = (value: number) =>
  value.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 4 });
export const time = (value: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Lima',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value)) + ' Lima';
export function age(value: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  return minutes < 60
    ? `${minutes}m ago`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)}h ago`
      : `${Math.floor(minutes / 1440)}d ago`;
}
