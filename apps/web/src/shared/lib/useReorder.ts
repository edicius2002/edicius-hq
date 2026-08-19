import { useState, type DragEvent, type KeyboardEvent } from 'react';

/**
 * Reordering a list by dragging — and by keyboard, which is the half that was
 * missing.
 *
 * Investing's watchlist and its positions table had already grown the same
 * fifteen lines of drag handling, character for character. A third copy in
 * Airfare is where duplication stops being an accident, so it lives here now
 * and all three call it.
 *
 * **The keyboard part is new.** Both existing copies were pointer-only, which
 * left reordering unreachable for anyone not using a mouse — a hole in a
 * codebase that has otherwise gone to some trouble to be drivable without one.
 * `Alt` with the arrow keys moves the focused row, the same shortcut editors
 * use to move a line, and `aria-keyshortcuts` says so out loud.
 *
 * `onMove(from, to)` means "put `from` where `to` currently sits" — the same
 * contract `investing/data/watchlist.reorder` already had, because a drop
 * between rows is a request for a position, not a swap.
 */

/**
 * Which arrows move a card, and what they mean.
 *
 * `vertical` is the list case and the default: up is earlier, down is later,
 * and left and right belong to the page. `both` adds left and right with the
 * *same* meaning — one place earlier, one place later — for a caller whose
 * items wrap into a grid, where left and right are the axis the eye follows
 * along a row and an arrow that did nothing would read as broken.
 *
 * Deliberately *not* "up moves a whole row up". How many cards sit in a row is
 * decided by `auto-fill` against whatever width the panel happens to have, so
 * that offset is three places at one window size and five at another, and
 * nothing in the DOM tells this hook which it currently is. A shortcut whose
 * effect changes when you resize the window is not one anybody can trust.
 * Earlier and later are stable, and they are also what gets persisted.
 */
export type ReorderAxis = 'vertical' | 'both';

export type ReorderOptions<T extends string> = {
  /** The ids in their current order. Needed to find a row's neighbour. */
  order: readonly T[];
  onMove: (from: T, to: T) => void;
  axis?: ReorderAxis;
};

export type RowProps = {
  draggable: true;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  'aria-keyshortcuts': string;
};

const SHORTCUTS: Record<ReorderAxis, string> = {
  vertical: 'Alt+ArrowUp Alt+ArrowDown',
  both: 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight',
};

/** How far the pressed key moves the row: 0 means the key is not ours. */
function offsetFor(key: string, axis: ReorderAxis): number {
  if (key === 'ArrowUp') return -1;
  if (key === 'ArrowDown') return 1;
  if (axis === 'both' && key === 'ArrowLeft') return -1;
  if (axis === 'both' && key === 'ArrowRight') return 1;
  return 0;
}

export function useReorder<T extends string>({
  order,
  onMove,
  axis = 'vertical',
}: ReorderOptions<T>) {
  const [dragging, setDragging] = useState<T | null>(null);

  function move(id: T, offset: number): void {
    const index = order.indexOf(id);
    const neighbour = order[index + offset];
    // At either end there is nowhere to go, and doing nothing quietly is the
    // right answer — a list that wraps around surprises everyone who tries it.
    if (index < 0 || neighbour === undefined) return;
    onMove(id, neighbour);
  }

  function rowProps(id: T): RowProps {
    return {
      draggable: true,
      onDragStart: () => setDragging(id),
      onDragEnd: () => setDragging(null),
      // Without this the browser refuses the drop and the row springs back.
      onDragOver: (event: DragEvent) => event.preventDefault(),
      onDrop: () => {
        if (dragging && dragging !== id) onMove(dragging, id);
        setDragging(null);
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (!event.altKey) return;
        const offset = offsetFor(event.key, axis);
        if (offset === 0) return;
        // The row is usually a button inside a list; without this the page
        // scrolls under the reorder.
        event.preventDefault();
        move(id, offset);
      },
      'aria-keyshortcuts': SHORTCUTS[axis],
    };
  }

  return { dragging, rowProps };
}
