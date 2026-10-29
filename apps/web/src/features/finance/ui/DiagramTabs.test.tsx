import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createEmptyDiagram } from '@/features/finance/lib/document';

import { DiagramTabs } from './DiagramTabs';

const DIAGRAMS = [createEmptyDiagram('one', 'One'), createEmptyDiagram('two', 'Two')];

describe('DiagramTabs', () => {
  it('uses honest navigation semantics instead of incomplete tab semantics', () => {
    render(
      <DiagramTabs
        diagrams={DIAGRAMS}
        activeId="one"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onDuplicate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole('navigation', { name: 'Diagrams' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'One' })).toHaveAttribute('aria-current', 'page');
  });

  it('edits the active diagram by clicking its name and commits from the keyboard', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(
      <DiagramTabs
        diagrams={DIAGRAMS}
        activeId="one"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onDuplicate={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Rename One' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'One' }));
    const input = screen.getByRole('textbox', { name: 'Rename One' });
    await user.clear(input);
    await user.type(input, 'Primary{Enter}');

    expect(onRename).toHaveBeenCalledWith('one', 'Primary');
  });

  it('moves focus to the next available diagram after deletion', async () => {
    const user = userEvent.setup();

    function StatefulTabs() {
      const [diagrams, setDiagrams] = useState(DIAGRAMS);
      const [activeId, setActiveId] = useState('one');
      return (
        <DiagramTabs
          diagrams={diagrams}
          activeId={activeId}
          onSelect={setActiveId}
          onAdd={vi.fn()}
          onDuplicate={vi.fn()}
          onRename={vi.fn()}
          onDelete={(id) => {
            setDiagrams((current) => current.filter((diagram) => diagram.id !== id));
            setActiveId('two');
          }}
        />
      );
    }

    render(<StatefulTabs />);
    await user.click(screen.getByRole('button', { name: 'Delete One' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete diagram?' });
    expect(dialog).toHaveTextContent('One');
    expect(screen.getByRole('button', { name: 'One' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete diagram' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Two' })).toHaveFocus();
  });

  it('keeps the diagram when deletion is cancelled', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <DiagramTabs
        diagrams={DIAGRAMS}
        activeId="one"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onDuplicate={vi.fn()}
        onRename={vi.fn()}
        onDelete={onDelete}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Delete One' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete diagram?' })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'One' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete One' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Delete One' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
