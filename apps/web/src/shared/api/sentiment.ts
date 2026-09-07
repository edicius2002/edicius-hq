import { apiRequest } from '@/shared/api/http';

export type SentimentClassification =
  'extreme fear' | 'fear' | 'neutral' | 'greed' | 'extreme greed';

export type SentimentPoint = {
  timestamp: string;
  value: number;
  classification?: SentimentClassification;
};

export type SentimentSeries = {
  key: string;
  label: string;
  unit: string;
  points: SentimentPoint[];
};

export type SentimentMetric = {
  key: string;
  label: string;
  score: number;
  classification: SentimentClassification;
  timestamp: string;
  series: SentimentSeries[];
};

export type SentimentResponse = {
  source: 'cnn';
  fetchedAt: string;
  asOf: string;
  stale: boolean;
  composite: SentimentMetric;
  indicators: SentimentMetric[];
};

const SENTIMENT_TIMEOUT_MS = 15_000;

export function getSentiment(signal?: AbortSignal): Promise<SentimentResponse> {
  return apiRequest<SentimentResponse>('/api/sentiment', {
    signal,
    timeoutMs: SENTIMENT_TIMEOUT_MS,
  });
}
