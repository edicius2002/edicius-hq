/**
 * The node project's setup, and deliberately only this much of `setup.ts`.
 *
 * The rest of that file fills gaps jsdom has — `ResizeObserver`, `PointerEvent`,
 * `Blob.text`, `EventSource` — and none of it can even be evaluated here:
 * `PointerEventStub extends MouseEvent` is a `ReferenceError` in node, because
 * the class body is evaluated inside the `typeof PointerEvent === 'undefined'`
 * branch, which node always enters. `afterEach(cleanup)` is Testing Library's
 * and belongs with the renders, which is to say with jsdom.
 *
 * The rejecting `fetch` is the one piece that is worth just as much here. A
 * storage write leaves on a trailing debounce and can fire after the test that
 * caused it has finished and `vi.unstubAllGlobals()` has put the real `fetch`
 * back; it then goes to whatever is serving the API base URL, which during
 * development is the developer's own API over their own data. That is not
 * hypothetical — a fixture document replaced a real one once. Assigning here
 * rather than through `vi.stubGlobal` is deliberate for the same reason as in
 * `setup.ts`: this becomes the value a test's own stub is restored *to*, so a
 * late write fails loudly instead of quietly succeeding against something real.
 */
globalThis.fetch = () =>
  Promise.reject(new Error('fetch was called without a stub. Tests must not reach the network.'));
