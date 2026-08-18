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

export type ReorderOptions<T extends string> = {
  /** The ids in their current order. Needed to find a row's neighbour. */
  order: readonly T[];
  onMove: (from: T, to: T) => void;
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

export function useReorder<T extends string>({ order, onMove }: ReorderOptions<T>) {
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
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        // The row is usually a button inside a list; without this the page
        // scrolls under the reorder.
        event.preventDefault();
        move(id, event.key === 'ArrowUp' ? -1 : 1);
      },
      'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
    };
  }

  return { dragging, rowProps };
}
