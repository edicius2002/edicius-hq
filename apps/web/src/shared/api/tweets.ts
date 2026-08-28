import { apiRequest } from '@/shared/api/http';
import { getApiBaseUrl } from '@/shared/api/config';

export type Tweet = {
  id: string;
  date: string;
  text: string;
  isReply: boolean;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  url: string;
};

export type TweetsResponse = {
  handle: string;
  tweets: Tweet[];
};

/**
 * One capture's worth of a handle's timeline, newest first.
 *
 * The ordering is the server's, not this caller's: `limit` has to mean "the
 * newest N" rather than "whichever N the file happens to hold first", so the
 * sort belongs on the side that applies the limit.
 */
export function fetchTweets(handle: string, signal?: AbortSignal) {
  return apiRequest<TweetsResponse>(`/api/tweets/${encodeURIComponent(handle)}`, { signal });
}

export type Refresh = {
  handle: string;
  state: string;
  scroll: number;
  new: number;
  error: string | null;
  finishedAt: string | null;
};

/**
 * Ask for one incremental capture, and read how it is going.
 *
 * Two calls against one path, the way the fare collector's pass is shaped:
 * POST starts a run and answers with its state, GET answers with the same
 * document afterwards. Starting while one is already running returns that run
 * rather than opening a second browser — the scraper's profile directory is
 * locked by whichever process holds it, and a second one captures nothing.
 */
export function startRefresh(handle: string, signal?: AbortSignal) {
  return apiRequest<Refresh>(`/api/tweets/${encodeURIComponent(handle)}/refresh`, {
    method: 'POST',
    signal,
  });
}

export function fetchRefresh(handle: string, signal?: AbortSignal) {
  return apiRequest<Refresh>(`/api/tweets/${encodeURIComponent(handle)}/refresh`, { signal });
}

export function startWatch(handle: string) {
  return apiRequest<Refresh>(`/api/tweets/${encodeURIComponent(handle)}/watch`, { method: 'POST' });
}

export function stopWatch(handle: string) {
  return apiRequest<Refresh>(`/api/tweets/${encodeURIComponent(handle)}/watch`, { method: 'DELETE' });
}

export function openTweetStream(handle: string, onTweets: () => void): () => void {
  const source = new EventSource(`${getApiBaseUrl()}/api/tweets/${encodeURIComponent(handle)}/stream`);
  source.addEventListener('tweets', onTweets);
  return () => source.close();
}
