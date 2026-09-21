import { supabase } from '@/shared/supabase/client';
import type { Json } from '@/shared/supabase/database.types';

export type Tweet = {
  id: string;
  date: string;
  text: string;
  isReply: boolean;
  url: string;
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
