import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useProjectorCapital } from '@/features/greenlight/hooks/useProjectorCapital';

/**
 * The capital field's memory, which is a store of its own and not the Greenlight
 * document.
 *
 * Two of these tests are about time rather than about values. The stored answer
 * arrives from the local API a moment after the net does, so there is a window
 * in which the field could show the page's figure and then replace it with a
 * different one — and a second window in which a reader can start typing before
 * the read lands. Both are held open deliberately below, with a GET that does
 * not answer until the test says so.
 */

afterEach(() => {
  // Unmounted before the stub goes: a hook left mounted would let its debounce
  // fire into the next test, or into whatever `fetch` is by then.
  cleanup();
  vi.unstubAllGlobals();
});

const NET_TEXT = '20377,8';

type StoredView = { version: number; capital: string | null };

/** Fake KV endpoint for one key. `hold` makes the GET wait for `release()`. */
function stubKv(options: { stored?: StoredView | null; hold?: boolean } = {}) {
  let stored: StoredView | null = options.stored ?? null;
  const writes: StoredView[] = [];
  let release = () => undefined as void;
  const answered = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { value: StoredView };
        stored = body.value;
        writes.push(body.value);
        return Response.json({ key: 'greenlight-projector', value: body.value });
      }

      if (options.hold) await answered;
      // Nothing has ever been stored under this key, which is what the API says
      // about every key until the first write.
      if (stored === null) return new Response(null, { status: 404 });
      return Response.json({ key: 'greenlight-projector', value: stored });
    }),
  );

  return {
    writes,
    release: () => {
      release();
    },
    get stored() {
      return stored;
    },
  };
}

/** A fresh cache per mount, so a second mount really re-reads. */
function TestWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mount() {
  return renderHook(() => useProjectorCapital(NET_TEXT), { wrapper: TestWrapper });
}

/** Leaving the page flushes the debounce, the same way a route change does. */
async function leavePage(view: { unmount: () => void }) {
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  view.unmount();
}

describe('remembering the capital', () => {
  it('brings back what was typed in an earlier visit, in place of the page net', async () => {
    const api = stubKv();

    const first = mount();
    await waitFor(() => expect(first.result.current.isFetching).toBe(false));
    expect(first.result.current.capitalText).toBe(NET_TEXT);

    act(() => {
      first.result.current.setCapitalText('1000');
    });
    // Held by the debounce rather than sent per keystroke.
    expect(api.writes).toHaveLength(0);
    await leavePage(first);
    await waitFor(() => expect(api.stored?.capital).toBe('1000'));

    const second = mount();
    await waitFor(() => expect(second.result.current.isFetching).toBe(false));
    expect(second.result.current.capitalText).toBe('1000');
  });

  it('follows the page again once the field is cleared', async () => {
    // The way out, and the only one: a capital otherwise outlives every later
    // net, including one that arrives with a fresh CSV.
    const api = stubKv({ stored: { version: 1, capital: '1000' } });

    const first = mount();
    await waitFor(() => expect(first.result.current.capitalText).toBe('1000'));

    act(() => {
      first.result.current.setCapitalText('');
    });
    // Emptied, the field stays empty for as long as the reader is in it — it
    // does not refill itself with the net under the cursor mid-deletion.
    expect(first.result.current.capitalText).toBe('');
    await leavePage(first);
    await waitFor(() => expect(api.stored?.capital).toBeNull());

    const second = mount();
    await waitFor(() => expect(second.result.current.isFetching).toBe(false));
    expect(second.result.current.capitalText).toBe(NET_TEXT);
  });
});

describe('while the stored answer is still on its way', () => {
  it('shows nothing rather than the net it may be about to replace', async () => {
    const api = stubKv({ stored: { version: 1, capital: '1000' }, hold: true });

    const view = mount();
    expect(view.result.current.isFetching).toBe(true);
    // Blank is not a figure. Printing the net here and swapping it for $1,000 a
    // moment later would put a number on screen that was never the answer.
    expect(view.result.current.capitalText).toBe('');

    api.release();
    await waitFor(() => expect(view.result.current.isFetching).toBe(false));
    expect(view.result.current.capitalText).toBe('1000');
  });

  it('does not overwrite what the reader has already started typing', async () => {
    const api = stubKv({ stored: { version: 1, capital: '1000' }, hold: true });

    const view = mount();
    act(() => {
      view.result.current.setCapitalText('55');
    });
    expect(view.result.current.capitalText).toBe('55');

    api.release();
    await waitFor(() => expect(view.result.current.isFetching).toBe(false));
    expect(view.result.current.capitalText).toBe('55');

    // And the late read does not win the write either: what reaches storage is
    // the reader's 55, not the 1000 it was carrying.
    await leavePage(view);
    await waitFor(() => expect(api.stored?.capital).toBe('55'));
  });
});

describe('when the store cannot be read at all', () => {
  it('falls back to the page net and still lets the field be typed in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'PUT') return Response.json({ key: 'x', value: null });
        return Response.json({ detail: 'boom' }, { status: 500 });
      }),
    );

    const view = mount();
    await waitFor(() => expect(view.result.current.isFetching).toBe(false));
    expect(view.result.current.capitalText).toBe(NET_TEXT);

    // The facade refuses to write over a document it could not read, so this
    // capital lasts the session and no longer. Typing must not throw for it.
    act(() => {
      view.result.current.setCapitalText('1000');
    });
    expect(view.result.current.capitalText).toBe('1000');
    await leavePage(view);
  });
});
