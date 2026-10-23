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

const kinds: SeaceKind[] = ['notices', 'processes', 'contracts'];

export async function loadSeace(region: string, year: number): Promise<SeaceRow[]> {
  const result: SeaceRow[] = [];
  for (const kind of kinds) {
    for (let start = 0; ; start += 500) {
      const { data, error } = await supabase
        .from('seace_records')
        .select('kind,record_key,payload')
        .eq('region', region)
        .eq('year', year)
        .eq('kind', kind)
        .order('record_key')
        .range(start, start + 499);
      if (error) throw new Error('SEACE records unavailable');
      for (const row of data ?? []) {
        if (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)) {
          result.push({ kind, recordKey: row.record_key, payload: row.payload });
        }
      }
      if ((data ?? []).length < 500) break;
    }
  }
  return result;
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

export async function loadExclusions(): Promise<Set<string>> {
  const result = new Set<string>();
  for (let start = 0; ; start += 500) {
    const { data, error } = await supabase
      .from('seace_exclusions')
      .select('record_key')
      .order('record_key')
      .range(start, start + 499);
    if (error) throw new Error('SEACE exclusions unavailable');
    for (const row of data ?? []) result.add(row.record_key);
    if ((data ?? []).length < 500) break;
  }
  return result;
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
    const { error } = await supabase.from('seace_exclusions').delete().in('record_key', keys);
    if (error) throw new Error('Could not restore selected records');
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
