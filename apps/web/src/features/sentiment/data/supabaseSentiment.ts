import type { SentimentResponse } from '@/shared/api/sentiment';
import { supabase } from '@/shared/supabase/client';

function normalizeSentiment(value: unknown): SentimentResponse {
  if (!value || typeof value !== 'object')
    throw new Error('Sentiment snapshot payload is invalid.');
  return value as SentimentResponse;
}

/** The authenticated browser sees only its own row through sentiment RLS. */
export async function getLatestSentiment(signal?: AbortSignal): Promise<SentimentResponse> {
  void signal;
  const { data, error } = await supabase
    .from('sentiment_snapshots')
    .select('payload')
    .order('as_of', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data?.[0]) throw new Error('No sentiment snapshot is available yet.');
  return normalizeSentiment(data[0].payload);
}
