import { type PointerEvent } from 'react';

import { formatAmount } from '@/shared/lib/money';
import { RESIZE_EDGES, type ResizeEdge } from '@/features/finance/lib/frames';
import type { FrameSummary } from '@/features/finance/lib/summary';
import type { Frame } from '@/features/finance/model/types';

import styles from './FrameBox.module.css';

type FrameBoxProps = {
  frame: Frame;
  summary: FrameSummary;
  selected: boolean;
  onSelect: () => void;
  onMoveStart: (event: PointerEvent<HTMLElement>) => void;
  onResizeStart: (edge: ResizeEdge, event: PointerEvent<HTMLElement>) => void;
};

/**
 * A named region drawn under the nodes.
 *
 * Its body is transparent to the pointer, and only the header and the handles
 * answer to one. A frame can cover most of the canvas, so if its body caught
 * presses it would swallow every pan started inside it and make the diagram feel
 * stuck — and the nodes underneath would stop being the first thing you can
 * grab.
 */
export function FrameBox({
  frame,
  summary,
  selected,
  onSelect,
  onMoveStart,
  onResizeStart,
}: FrameBoxProps) {
  return (
    <section
      className={`${styles.frame} ${selected ? styles.selected : ''}`}
      style={{
        left: frame.position.x,
        top: frame.position.y,
        width: frame.size.width,
        height: frame.size.height,
      }}
      aria-label={`Frame ${frame.name}`}
    >
      <header
        className={styles.header}
        title="Drag to move the frame"
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
          onMoveStart(event);
        }}
      >
        <span className={styles.name}>{frame.name || 'Frame'}</span>
        <span className={styles.meta}>
          {summary.nodeCount} {summary.nodeCount === 1 ? 'node' : 'nodes'}
        </span>

        {summary.totals.length ? (
          <span className={styles.totals}>
            {summary.totals.map((total) => (
              <span key={total.asset} className={styles.total}>
                <strong>{total.asset}</strong> {formatAmount(total.amount)}
              </span>
            ))}
          </span>
        ) : null}
      </header>

      {RESIZE_EDGES.map((edge) => (
        <span
          key={edge}
          className={`${styles.handle} ${styles[edge]}`}
          aria-hidden="true"
          onPointerDown={(event) => {
            event.stopPropagation();
            onSelect();
            onResizeStart(edge, event);
          }}
        />
      ))}
    </section>
  );
}
