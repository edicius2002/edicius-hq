import type { SentimentResponse } from '@/shared/api/sentiment';
import { supabase } from '@/shared/supabase/client';

export class NoSentimentSnapshotError extends Error {
  constructor() {
    super('No sentiment snapshot is available yet.');
    this.name = 'NoSentimentSnapshotError';
  }
}

function normalizeSentiment(value: unknown): SentimentResponse {
  if (!value || typeof value !== 'object')
    throw new Error('Sentiment snapshot payload is invalid.');
  return value as SentimentResponse;
}

/** The authenticated browser sees only its own row through sentiment RLS. */
export async function getLatestSentiment(signal?: AbortSignal): Promise<SentimentResponse> {
  const query = supabase
    .from('sentiment_snapshots')
    .select('payload')
    .order('as_of', { ascending: false })
    .limit(1);
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw error;
  if (!data?.[0]) throw new NoSentimentSnapshotError();
  return normalizeSentiment(data[0].payload);
}
