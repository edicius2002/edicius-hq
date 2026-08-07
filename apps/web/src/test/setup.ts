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
 * jsdom has no PointerEvent, and without the constructor a dispatched
 * `pointerdown` arrives as a bare Event carrying none of the coordinates the
 * Finance canvas drags by — handlers then compute NaN and nothing moves. Built
 * on the MouseEvent jsdom does have, which already carries the client
 * coordinates and the buttons, with the two pointer fields the canvas reads
 * added on top.
 */
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    readonly isPrimary: boolean;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.isPrimary = init.isPrimary ?? true;
    }
  }

  globalThis.PointerEvent = PointerEventStub as unknown as typeof PointerEvent;
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
