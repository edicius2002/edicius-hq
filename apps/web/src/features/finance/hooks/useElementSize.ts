import { useEffect, useRef, useState, type RefObject } from 'react';

import type { Size } from '@/features/finance/lib/geometry';

const EMPTY: Size = { width: 0, height: 0 };

/**
 * The measured size of an element. The camera needs it to fit a diagram and to
 * work out what is on screen, and neither can be answered from the diagram
 * alone. Measured rather than assumed because the canvas is sized in `vh`.
 */
export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, Size] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Size>(EMPTY);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      const { clientWidth: width, clientHeight: height } = element;
      // Same numbers, same object: a new one every observation would re-render
      // the canvas for nothing.
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}
