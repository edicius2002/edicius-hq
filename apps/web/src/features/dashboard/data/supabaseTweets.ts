import { supabase } from '@/shared/supabase/client';
import type { Json } from '@/shared/supabase/database.types';

export type Tweet = {
  id: string;
  date: string;
  text: string;
  isReply: boolean;
  url: string;
};

export type TweetRun = {
  status: string;
  completed_at: string | null;
  error_code?: string | null;
};

function tweetFromRow(postId: string, postedAt: string, payload: Json): Tweet {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return {
    id: postId,
    date: postedAt,
    text: typeof value.text === 'string' ? value.text : '',
    isReply: value.is_reply === true,
    url: typeof value.url === 'string' ? value.url : `https://x.com/i/status/${postId}`,
  };
}

export async function fetchTweets(handle: string): Promise<Tweet[]> {
  const { data, error } = await supabase
    .from('tweet_posts')
    .select('post_id, posted_at, payload')
    .eq('handle', handle)
    .order('posted_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []).map((row) => tweetFromRow(row.post_id, row.posted_at, row.payload));
}

export async function fetchLatestTweetRun(): Promise<TweetRun | null> {
  const { data, error } = await supabase
    .from('collector_runs')
    .select('status, completed_at, error_code')
    .eq('collector', 'x-posts')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function subscribeTweets(handle: string, onInsert: () => void): () => void {
  const channel = supabase
    .channel(`tweets:${handle}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'tweet_posts', filter: `handle=eq.${handle}` },
      onInsert,
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
