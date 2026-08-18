import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { useReorder } from '@/shared/lib/useReorder';

/**
 * The keyboard half is what these mostly cover. Dragging is exercised through
 * the three lists that use it; `Alt` with an arrow is the part that did not
 * exist before this hook and is the part a mouse-only test would never reach.
 */

function List({ order, onMove }: { order: string[]; onMove: (from: string, to: string) => void }) {
  const { dragging, rowProps } = useReorder({ order, onMove });
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
});
