import { apiFetch } from '@/shared/api/http';

const RECONNECT_DELAY_MS = 3_000;

export type EventStreamEvent = {
  type: string;
  data: string;
  id: string | null;
};

export type EventStreamHandlers = {
  onOpen?: () => void;
  onEvent: (event: EventStreamEvent) => void;
  onError?: () => void;
};

export type EventStreamOptions = {
  signal?: AbortSignal;
};

function waitForReconnect(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(done, RECONNECT_DELAY_MS);

    function done() {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }

    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Opens a bearer-authenticated server-sent-event stream with native-style
 * reconnect semantics, without putting a JWT in a URL. SSE is a GET transport,
 * so reconnecting this layer never retries a non-idempotent request.
 */
export function openApiEventStream(
  path: string,
  handlers: EventStreamHandlers,
  options: EventStreamOptions = {},
): () => void {
  const controller = new AbortController();
  let lastEventId: string | null = null;
  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromParent, { once: true });
  if (options.signal?.aborted) controller.abort();

  async function consume(response: Response): Promise<void> {
    if (!response.body) throw new Error('SSE response had no body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];
    let eventType = '';

    const dispatch = () => {
      if (data.length > 0) {
        handlers.onEvent({ type: eventType || 'message', data: data.join('\n'), id: lastEventId });
      }
      data = [];
      eventType = '';
    };

    const readLine = (line: string) => {
      if (line === '') {
        dispatch();
        return;
      }
      if (line.startsWith(':')) return;

      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      const valueWithOptionalSpace = separator === -1 ? '' : line.slice(separator + 1);
      const value = valueWithOptionalSpace.startsWith(' ')
        ? valueWithOptionalSpace.slice(1)
        : valueWithOptionalSpace;

      if (field === 'data') data.push(value);
      if (field === 'event') eventType = value;
      if (field === 'id' && value !== '' && !value.includes('\0')) lastEventId = value;
    };

    const consumeLines = (finished = false) => {
      for (;;) {
        const newline = buffer.search(/[\r\n]/);
        if (newline === -1) return;
        if (buffer[newline] === '\r' && newline === buffer.length - 1 && !finished) return;

        const line = buffer.slice(0, newline);
        const lineEndingLength = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(newline + lineEndingLength);
        readLine(line);
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        consumeLines();
      }
      buffer += decoder.decode();
      consumeLines(true);
    } finally {
      reader.releaseLock();
    }
  }

  async function run(): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        const headers = new Headers({ Accept: 'text/event-stream' });
        if (lastEventId) headers.set('Last-Event-ID', lastEventId);
        const response = await apiFetch(path, { headers, signal: controller.signal });
        if (!response.ok) throw new Error(`SSE request failed with status ${response.status}`);
        handlers.onOpen?.();
        await consume(response);
      } catch {
        if (controller.signal.aborted) return;
        handlers.onError?.();
      }

      if (controller.signal.aborted) return;
      await waitForReconnect(controller.signal);
    }
  }

  void run();
  return () => {
    options.signal?.removeEventListener('abort', abortFromParent);
    controller.abort();
  };
}
