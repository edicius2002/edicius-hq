import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NARROW_QUERY, useIsNarrow } from '@/app/layout/useIsNarrow';

/**
 * jsdom parses a media query and then answers `false` to every width in it —
 * it lays nothing out, so there is no width to compare against. That is the
 * whole reason this hook exists as a hook: the shell picks its navigation in
 * JavaScript, the suite keeps seeing the wide branch by default, and a test
 * that wants the narrow one says so by installing the stub below.
 */

type Listener = (event: MediaQueryListEvent) => void;

function installMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  const list = {
    matches,
    media: NARROW_QUERY,
    addEventListener: (_: string, listener: Listener) => void listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) => void listeners.delete(listener),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => list),
  );
  return {
    /** What the browser does when the viewport crosses the threshold. */
    change(next: boolean) {
      list.matches = next;
      act(() => {
        for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
      });
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function Probe() {
  return <span>{useIsNarrow() ? 'narrow' : 'wide'}</span>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useIsNarrow', () => {
  it('reports wide when the query does not match', () => {
    installMatchMedia(false);
    render(<Probe />);
    expect(screen.getByText('wide')).toBeInTheDocument();
  });

  it('reports narrow when the query matches on the first render', () => {
    installMatchMedia(true);
    render(<Probe />);
    expect(screen.getByText('narrow')).toBeInTheDocument();
  });

  it('follows the viewport across the threshold', () => {
    const media = installMatchMedia(false);
    render(<Probe />);
    expect(screen.getByText('wide')).toBeInTheDocument();

    media.change(true);
    expect(screen.getByText('narrow')).toBeInTheDocument();

    media.change(false);
    expect(screen.getByText('wide')).toBeInTheDocument();
  });

  it('drops its listener on unmount', () => {
    const media = installMatchMedia(true);
    const view = render(<Probe />);
    expect(media.listenerCount).toBe(1);

    view.unmount();
    expect(media.listenerCount).toBe(0);
  });

  /*
   * `RouteMap` guards its own `matchMedia` call the same way. The shell renders
   * before anything else does, so an environment without the function has to
   * produce a navigable page rather than a crash — and the wide branch is the
   * one that needs no gesture to reach.
   */
  it('falls back to wide where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<Probe />);
    expect(screen.getByText('wide')).toBeInTheDocument();
  });
});
