import { useEffect, useRef, useState, type RefObject } from 'react';

export type Size = { width: number; height: number };

const EMPTY: Size = { width: 0, height: 0 };

/**
 * The measured size of an element.
 *
 * Lives in shared because two features need it and features may not import
 * each other: the Finance camera needs it to fit a diagram, and the Investing
 * chart needs it to size its canvas. Measured rather than assumed, because
 * both are sized in viewport units.
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
