import type { CSSProperties } from 'react';

import styles from './Skeleton.module.css';

type SkeletonProps = {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  radius?: CSSProperties['borderRadius'];
  className?: string;
};

/** A purely visual placeholder; its parent supplies the loading announcement. */
export function Skeleton({ width, height, radius, className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={[styles.skeleton, className].filter(Boolean).join(' ')}
      style={{ width, height, borderRadius: radius }}
    />
  );
}
