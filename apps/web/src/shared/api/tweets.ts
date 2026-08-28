import { apiRequest } from '@/shared/api/http';
export type Tweet = { id: string; date: string; text: string; isReply: boolean; likeCount: number; retweetCount: number; replyCount: number; url: string };
export type TweetsResponse = { handle: string; tweets: Tweet[] };
export function fetchTweets(handle: string, signal?: AbortSignal) { return apiRequest<TweetsResponse>(`/api/tweets/${encodeURIComponent(handle)}`, { signal }); }
