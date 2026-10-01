import { supabase } from '@/shared/supabase/client';
import { parseLatest, parseHistory } from './model';
import type { Source, Range } from './sources';
export async function fetchLatest(signal: AbortSignal) {
  const { data, error } = await supabase.rpc('read_fx_latest').abortSignal(signal);
  if (error) throw error;
  return parseLatest(data);
}
export async function fetchHistory(source: Source, range: Range, signal: AbortSignal) {
  const { data, error } = await supabase
    .rpc('read_fx_history', { p_source: source, p_range: range })
    .abortSignal(signal);
  if (error) throw error;
  return parseHistory(data, source);
}

export function subscribeFxObservations(ownerId: string, onChange: () => void): () => void {
  const filter = `owner_id=eq.${ownerId}`;
  const channel = supabase
    .channel(`fx-observations:${ownerId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'fx_observations', filter },
      onChange,
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'fx_observations', filter },
      onChange,
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
