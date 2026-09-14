import { apiRequest } from '@/shared/api/http';

export type CodexResetSource = {
  type: 'x_post' | 'observed';
  author?: string;
  url: string;
};

export type CodexReset = {
  id: string;
  resetType: 'regular' | 'banked';
  announcedAt: string;
  text: string;
  source: CodexResetSource;
};

export type CodexResetsResponse = {
  source: 'codex-resets.com';
  fetchedAt: string;
  generatedAt: string;
  stale: boolean;
  latestReset: CodexReset | null;
  stats: {
    total: number;
    avgIntervalDays: number | null;
    longestIntervalDays: number | null;
  };
  resets: CodexReset[];
};

export function fetchCodexResets(signal?: AbortSignal): Promise<CodexResetsResponse> {
  return apiRequest<CodexResetsResponse>('/api/codex-resets', { signal, timeoutMs: 20_000 });
}
