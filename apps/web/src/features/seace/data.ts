import { supabase } from '@/shared/supabase/client';

export type SeaceKind = 'notices' | 'processes' | 'contracts';
export type SeaceRow = {
  kind: SeaceKind;
  recordKey: string;
  payload: Record<string, unknown>;
};
export type SeaceSync = {
  kind: string;
  fetched_at: string;
  record_count: number;
  new_count: number | null;
};

export type SeaceView = 'recent' | 'open' | 'closed' | 'published';
export type SeacePageQuery = {
  region: string;
  year: number;
  view: SeaceView;
  minorOnly: boolean;
  objectFilter: string;
  excluded: boolean;
  search: string;
  sortField: string;
  ascending: boolean;
  page: number;
  pageSize: number;
  now: string;
};
export type SeacePageResult = { rows: SeaceRow[]; total: number };

export async function loadSeacePage(query: SeacePageQuery): Promise<SeacePageResult> {
  const { data, error } = await supabase.rpc('read_owner_seace_page', {
    p_region: query.region,
    p_year: query.year,
    p_view: query.view,
    p_minor_only: query.minorOnly,
    p_object_filter: query.objectFilter,
    p_excluded: query.excluded,
    p_search: query.search,
    p_sort_field: query.sortField,
    p_ascending: query.ascending,
    p_page: query.page,
    p_page_size: query.pageSize,
    p_now: query.now,
  });
  if (error) throw new Error('SEACE records unavailable');
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Invalid SEACE page response');
  const total = data.total;
  const rows = data.rows;
  if (
    !Number.isSafeInteger(total) ||
    typeof total !== 'number' ||
    total < 0 ||
    !Array.isArray(rows)
  )
    throw new Error('Invalid SEACE page response');
  const parsed: SeaceRow[] = rows.map((value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value.kind !== 'notices' && value.kind !== 'processes' && value.kind !== 'contracts') ||
      typeof value.recordKey !== 'string' ||
      !value.payload ||
      typeof value.payload !== 'object' ||
      Array.isArray(value.payload)
    )
      throw new Error('Invalid SEACE page response');
    return {
      kind: value.kind,
      recordKey: value.recordKey,
      payload: value.payload,
    };
  });
  return { rows: parsed, total };
}

export async function loadSeaceSync(region: string, year: number): Promise<SeaceSync[]> {
  const { data, error } = await supabase
    .from('seace_sync_state')
    .select('kind,fetched_at,record_count,new_count')
    .eq('region', region)
    .eq('year', year);
  if (!error) return data ?? [];

  // The UI can still show the timestamp before the new_count migration is applied.
  const legacy = await supabase
    .from('seace_sync_state')
    .select('kind,fetched_at,record_count')
    .eq('region', region)
    .eq('year', year);
  if (legacy.error) throw new Error('SEACE sync status unavailable');
  return (legacy.data ?? []).map((row) => ({ ...row, new_count: null }));
}

// PostgREST in-list literals need embedded quotes and backslashes escaped.
// Equality values are sent raw by postgrest-js, including JSON-shaped keys.
function recordKeyListLiteral(key: string): string {
  return '"' + key.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

const MAX_RESTORE_QUERY_LENGTH = 6000;

function restoreBatches(keys: string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const key of keys) {
    const candidate = [...batch, key];
    const filter = `in.(${candidate.map(recordKeyListLiteral).join(',')})`;
    if (
      batch.length &&
      new URLSearchParams({ record_key: filter }).toString().length > MAX_RESTORE_QUERY_LENGTH
    ) {
      batches.push(batch);
      batch = [key];
    } else {
      batch = candidate;
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export class SeacePartialRestoreError extends Error {
  constructor() {
    super('Some records may have been restored. Refreshing the table.');
    this.name = 'SeacePartialRestoreError';
  }
}

export async function setExcluded(key: string, excluded: boolean): Promise<void> {
  if (excluded) {
    const { error } = await supabase.from('seace_exclusions').insert({ record_key: key });
    if (error?.code === '23505') return;
    if (error) throw new Error('Could not exclude record');
  } else {
    const { error } = await supabase.from('seace_exclusions').delete().eq('record_key', key);
    if (error) throw new Error('Could not restore record');
  }
}

export async function setExcludedMany(keys: string[], excluded: boolean): Promise<void> {
  if (!keys.length) return;
  if (excluded) {
    const { error } = await supabase.from('seace_exclusions').upsert(
      keys.map((record_key) => ({ record_key })),
      {
        onConflict: 'owner_id,record_key',
        ignoreDuplicates: true,
        defaultToNull: false,
      },
    );
    if (error) throw new Error('Could not exclude selected records');
  } else {
    for (const [index, batch] of restoreBatches(keys).entries()) {
      const deletion = supabase.from('seace_exclusions').delete();
      const { error } =
        batch.length === 1
          ? await deletion.eq('record_key', batch[0])
          : await deletion.filter(
              'record_key',
              'in',
              `(${batch.map(recordKeyListLiteral).join(',')})`,
            );
      if (error) {
        if (index > 0) throw new SeacePartialRestoreError();
        throw new Error('Could not restore selected records');
      }
    }
  }
}

export function exclusionKey(row: SeaceRow): string {
  const value = row.payload;
  const text = (name: string) =>
    typeof value[name] === 'string' || typeof value[name] === 'number' ? String(value[name]) : '';
  if (row.kind !== 'processes') {
    return `minor:${JSON.stringify([text('region'), text('code').trim().toUpperCase()])}`;
  }
  return `process:${JSON.stringify([text('region'), text('code'), text('published'), text('entity')])}`;
}
