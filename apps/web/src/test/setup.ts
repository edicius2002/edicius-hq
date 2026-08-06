import '@testing-library/jest-dom/vitest';

/**
 * jsdom has no ResizeObserver, and the Finance canvas measures itself with one
 * to work out what the camera can see. A stub that observes nothing is enough:
 * jsdom reports every element as zero-sized anyway, so there is no size to
 * report a change in.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
