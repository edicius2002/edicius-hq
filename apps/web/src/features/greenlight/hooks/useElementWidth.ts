import { useEffect, useRef, useState } from 'react';

/**
 * Track an element's rendered width so an SVG chart can lay out in real pixels
 * instead of letterboxing a fixed viewBox inside a wider container.
 * Falls back to `fallback` when ResizeObserver is unavailable (jsdom, SSR).
 */
export function useElementWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}
