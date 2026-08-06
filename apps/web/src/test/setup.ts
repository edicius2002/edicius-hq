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

/**
 * jsdom's Blob has no `text()`, which the Finance backup uses to read a chosen
 * file. Filled in with the FileReader jsdom does have, rather than making the
 * product carry a workaround for a gap only this environment has — every
 * browser it targets has had `Blob.text` for years.
 */
if (typeof Blob !== 'undefined' && typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function text(this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}
