import { getApiBaseUrl } from '@/shared/api/config';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

type RequestOptions = {
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Overrides the default deadline. Market requests need it: the API waits up
   * to 12s on an upstream that is unofficial and sometimes slow, and giving up
   * at 5s here would abort calls the server was about to answer.
   */
  timeoutMs?: number;
};

const REQUEST_TIMEOUT_MS = 5_000;

function composeAbortSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([external, timeout]);
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (external.aborted || timeout.aborted) {
    controller.abort();
    return controller.signal;
  }
  external.addEventListener('abort', onAbort, { once: true });
  timeout.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = `${getApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: HeadersInit = {};
  let body: string | undefined;

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body,
    signal: composeAbortSignal(options.signal, options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const detail =
      typeof parsed === 'object' &&
      parsed !== null &&
      'detail' in parsed &&
      typeof parsed.detail === 'string'
        ? (parsed as { detail: string }).detail
        : `Request failed with status ${response.status}`;
    throw new ApiError(detail, response.status, parsed);
  }

  return parsed as T;
}
