import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { useReorder, type ReorderAxis } from '@/shared/lib/useReorder';

/**
 * The keyboard half is what these mostly cover. Dragging is exercised through
 * the three lists that use it; `Alt` with an arrow is the part that did not
 * exist before this hook and is the part a mouse-only test would never reach.
 */

function List({
  order,
  onMove,
  axis,
}: {
  order: string[];
  onMove: (from: string, to: string) => void;
  axis?: ReorderAxis;
}) {
  const { dragging, rowProps } = useReorder({ order, onMove, axis });
  return (
    <ul>
      {order.map((id) => (
        <li key={id} data-dragging={dragging === id} {...rowProps(id)}>
          <button type="button">{id}</button>
        </li>
      ))}
    </ul>
  );
}

function renderList(order = ['AAA', 'BBB', 'CCC']) {
  const onMove = vi.fn();
  const view = render(<List order={order} onMove={onMove} />);
  return { ...view, onMove };
}

function renderGrid(order = ['AAA', 'BBB', 'CCC']) {
  const onMove = vi.fn();
  const view = render(<List order={order} onMove={onMove} axis="both" />);
  return { ...view, onMove };
}

describe('useReorder', () => {
  it('moves a row up with Alt and an arrow', async () => {
    const user = userEvent.setup();
    const { onMove } = renderList();

    screen.getByText('BBB').focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');

    expect(onMove).toHaveBeenCalledWith('BBB', 'AAA');
  });

  it('moves a row down the same way', async () => {
    const user = userEvent.setup();
    const { onMove } = renderList();

    screen.getByText('BBB').focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(onMove).toHaveBeenCalledWith('BBB', 'CCC');
  });

  it('does nothing at either end rather than wrapping around', async () => {
    // A list that wraps surprises everyone who tries it, and a silent no-op is
    // what every editor does at the top of a file.
    const user = userEvent.setup();
    const { onMove } = renderList();

    screen.getByText('AAA').focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    screen.getByText('CCC').focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(onMove).not.toHaveBeenCalled();
  });

  it('leaves a plain arrow alone', async () => {
    // Arrows without a modifier belong to the page, not to this hook.
    const user = userEvent.setup();
    const { onMove } = renderList();

    screen.getByText('BBB').focus();
    await user.keyboard('{ArrowUp}');

    expect(onMove).not.toHaveBeenCalled();
  });

  it('announces the shortcut rather than hiding it', () => {
    renderList();
    expect(screen.getByText('AAA').closest('li')).toHaveAttribute(
      'aria-keyshortcuts',
      'Alt+ArrowUp Alt+ArrowDown',
    );
  });

  it('marks the row being dragged and clears it afterwards', () => {
    const { onMove } = renderList();
    const row = screen.getByText('BBB').closest('li')!;
    const target = screen.getByText('AAA').closest('li')!;

    expect(row).toHaveAttribute('draggable', 'true');

    fireEvent.dragStart(row);
    expect(screen.getByText('BBB').closest('li')).toHaveAttribute('data-dragging', 'true');

    fireEvent.drop(target);
    expect(onMove).toHaveBeenCalledWith('BBB', 'AAA');
    expect(screen.getByText('BBB').closest('li')).toHaveAttribute('data-dragging', 'false');
  });

  it('ignores a row dropped on itself', () => {
    const { onMove } = renderList();
    const row = screen.getByText('BBB').closest('li')!;

    fireEvent.dragStart(row);
    fireEvent.drop(row);

    expect(onMove).not.toHaveBeenCalled();
  });

  it('leaves the sideways arrows to the page in a list', async () => {
    // The default has to stay exactly what the watchlist and the Airfare route
    // list already had: one column, where a sideways arrow means nothing.
    const user = userEvent.setup();
    const { onMove } = renderList();

    screen.getByText('BBB').focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');

    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByText('AAA').closest('li')).toHaveAttribute(
      'aria-keyshortcuts',
      'Alt+ArrowUp Alt+ArrowDown',
    );
  });
});

describe('useReorder over a grid', () => {
  it('moves a card one place later with a right arrow, not one row later', async () => {
    // Right is the next card along a row, which is the next id in the order —
    // and the order is the only thing here that does not change with the width
    // of the panel.
    const user = userEvent.setup();
    const { onMove } = renderGrid();

    screen.getByText('BBB').focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');

    expect(onMove).toHaveBeenCalledWith('BBB', 'CCC');
  });

  it('moves a card one place earlier with a left arrow', async () => {
    const user = userEvent.setup();
    const { onMove } = renderGrid();

    screen.getByText('BBB').focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');

    expect(onMove).toHaveBeenCalledWith('BBB', 'AAA');
  });

  it('keeps up and down meaning the same two steps', async () => {
    // A reader arrives here having learnt the shortcut on the watchlist, and
    // at one column the grid genuinely is a list.
    const user = userEvent.setup();
    const { onMove } = renderGrid();

    screen.getByText('BBB').focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(onMove).toHaveBeenNthCalledWith(1, 'BBB', 'AAA');
    expect(onMove).toHaveBeenNthCalledWith(2, 'BBB', 'CCC');
  });

  it('announces all four arrows rather than half of them', () => {
    renderGrid();
    expect(screen.getByText('AAA').closest('li')).toHaveAttribute(
      'aria-keyshortcuts',
      'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight',
    );
  });

  it('still does nothing at either end of the order', async () => {
    const user = userEvent.setup();
    const { onMove } = renderGrid();

    screen.getByText('AAA').focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    screen.getByText('CCC').focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');

    expect(onMove).not.toHaveBeenCalled();
  });
});
