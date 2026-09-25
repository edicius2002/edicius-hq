/**
 * Codex usage-limit resets, read straight from codex-resets.com.
 *
 * This used to go through the home API's `/api/codex-resets`, which proxied
 * the same provider and normalised its answer. The deployed web app has no API
 * behind `localhost:8000`, so the dashboard card never loaded in production.
 * The provider is public and answers any origin (`Access-Control-Allow-Origin:
 * *`), so the browser asks it directly and the normalisation lives here. Its
 * `ETag` revalidation is the browser's HTTP cache's job now, and the minute-long
 * reuse is React Query's (`useCodexResets`).
 *
 * Only executed resets enter the snapshot: `scheduled_reset` and `active_watch`
 * are forecasts, not events, and are ignored exactly as the API ignored them.
 */

export type CodexResetSource = {
  type: 'x_post' | 'observed';
  author?: string;
  url: string;
};

export type CodexReset = {
  id: string;
  resetType: 'regular' | 'banked';
  announcedAt: string;
  text: string;
  source: CodexResetSource;
};

export type CodexResetsResponse = {
  source: 'codex-resets.com';
  fetchedAt: string;
  generatedAt: string;
  stale: boolean;
  latestReset: CodexReset | null;
  stats: {
    total: number;
    avgIntervalDays: number | null;
    longestIntervalDays: number | null;
  };
  resets: CodexReset[];
};

const UPSTREAM = 'https://codex-resets.com/api/v1';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const TIMEOUT_MS = 20_000;
const DAY_MS = 86_400_000;

/** The provider answered with something the card cannot trust. */
export class CodexResetsError extends Error {
  readonly code: 'rate-limited' | 'upstream-error' | 'unreachable' | 'invalid-payload';

  constructor(code: CodexResetsError['code'], message: string) {
    super(message);
    this.name = 'CodexResetsError';
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new CodexResetsError('invalid-payload', message);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** An ISO timestamp that names its zone, back as UTC without milliseconds. */
function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must be an ISO timestamp`);
  // A zoneless timestamp would be read in the viewer's own zone and move every
  // reset by their offset, so it is refused rather than guessed at.
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) invalid(`${field} needs a timezone`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) invalid(`${field} is not a valid timestamp`);
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function source(value: unknown): CodexResetSource {
  const item = object(value, 'source');
  if (item.type !== 'x_post' && item.type !== 'observed') invalid('source.type is invalid');
  if (typeof item.url !== 'string' || !item.url.startsWith('https://')) {
    invalid('source.url is invalid');
  }
  if (item.author !== undefined && item.author !== null && typeof item.author !== 'string') {
    invalid('source.author is invalid');
  }
  return typeof item.author === 'string'
    ? { type: item.type, author: item.author, url: item.url }
    : { type: item.type, url: item.url };
}

function codexReset(value: unknown): CodexReset {
  const item = object(value, 'reset');
  const resetType = item.reset_type ?? item.resetType;
  if (typeof item.id !== 'string' || !item.id) invalid('reset.id is invalid');
  if (resetType !== 'regular' && resetType !== 'banked') invalid('reset.reset_type is invalid');
  if (typeof item.text !== 'string') invalid('reset.text is invalid');
  return {
    id: item.id,
    resetType,
    announcedAt: timestamp(item.announced_at ?? item.announcedAt, 'reset.announced_at'),
    text: item.text,
    source: source(item.source),
  };
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`stats.${field} is invalid`);
  return value;
}

/** The longest gap between two consecutive resets, in days. */
function longestInterval(resets: readonly CodexReset[]): number | null {
  if (resets.length < 2) return null;
  const times = resets.map((item) => Date.parse(item.announcedAt)).sort((a, b) => a - b);
  let longest = 0;
  for (let index = 1; index < times.length; index += 1) {
    longest = Math.max(longest, (times[index] - times[index - 1]) / DAY_MS);
  }
  return longest;
}

async function get(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${UPSTREAM}${path}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new CodexResetsError('unreachable', 'Codex Resets is unreachable');
  }
  if (response.status === 429) {
    throw new CodexResetsError('rate-limited', 'Codex Resets rate-limited the request');
  }
  if (!response.ok) {
    throw new CodexResetsError('upstream-error', `Codex Resets returned HTTP ${response.status}`);
  }
  try {
    return object(await response.json(), 'response');
  } catch (error) {
    if (error instanceof CodexResetsError) throw error;
    return invalid('Codex Resets returned invalid JSON');
  }
}

/** The caller's cancellation, bounded by the same 20 s the API allowed. */
function bounded(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function fetchCodexResets(signal?: AbortSignal): Promise<CodexResetsResponse> {
  const within = bounded(signal);
  const status = await get('/status', within);
  const data = object(status.data, 'status.data');
  const meta = object(status.meta, 'status.meta');
  const stats = object(data.stats, 'status.stats');
  const latest = data.latest_reset;

  const byId = new Map<string, CodexReset>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page === MAX_PAGES) invalid(`resets pagination exceeded ${MAX_PAGES} pages`);
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), order: 'asc' });
    if (cursor !== null) query.set('cursor', cursor);
    const payload = await get(`/resets?${query}`, within);
    if (!Array.isArray(payload.data)) invalid('resets.data must be an array');
    for (const row of payload.data) {
      const item = codexReset(row);
      byId.set(item.id, item);
    }
    const pagination = object(payload.pagination, 'resets.pagination');
    if (pagination.has_more !== true) break;
    const next = pagination.next_cursor;
    if (typeof next !== 'string' || !next || seenCursors.has(next)) {
      invalid('resets pagination cursor is invalid');
    }
    seenCursors.add(next);
    cursor = next;
  }

  const resets = [...byId.values()].sort(
    (a, b) => Date.parse(a.announcedAt) - Date.parse(b.announcedAt) || a.id.localeCompare(b.id),
  );
  const total = stats.total;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
    invalid('stats.total is invalid');
  }

  return {
    source: 'codex-resets.com',
    fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    generatedAt: timestamp(meta.generated_at, 'status.meta.generated_at'),
    stale: false,
    latestReset: latest === undefined || latest === null ? null : codexReset(latest),
    stats: {
      total,
      avgIntervalDays: optionalNumber(stats.avg_interval_days, 'average'),
      longestIntervalDays: longestInterval(resets),
    },
    resets,
  };
}
