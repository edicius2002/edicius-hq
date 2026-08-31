import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEmptyDiagram } from '@/features/finance/lib/document';
import * as ops from '@/features/finance/lib/operations';
import type { Diagram } from '@/features/finance/model/types';

import { PropertiesPanel, type PropertiesPanelActions } from './PropertiesPanel';
import styles from './PropertiesPanel.module.css';

afterEach(cleanup);

/** A job paying USD into an account's holding, so both editors have real data. */
function diagramWithFlow(): Diagram {
  let diagram = ops.addJob(createEmptyDiagram('d1'), { id: 'j1', position: { x: 0, y: 0 } });
  diagram = ops.addJobAsset(diagram, 'j1', 'USD');
  diagram = ops.addAccount(diagram, { id: 'a1', position: { x: 300, y: 0 } });

  const holding = ops.addHolding(diagram, {
    id: 'h1',
    accountId: 'a1',
    asset: 'USD',
    position: { x: 300, y: 120 },
  });
  if (!holding.ok) throw new Error('fixture: the holding was refused');

  const flow = ops.connect(holding.value, { id: 'f1', from: 'j1', to: 'h1', amount: 100 });
  if (!flow.ok) throw new Error('fixture: the flow was refused');
  return flow.value;
}

function diagramWithSettleableFlow(): Diagram {
  return ops.setJobBalance(diagramWithFlow(), 'j1', 'USD', 100);
}

/**
 * The panel over a live document, so an edit comes back through the value it is
 * given. A field whose `onChange` goes nowhere accepts one keystroke and forgets
 * it, which is not the thing being tested here.
 */
function StatefulPanel({
  selection,
  initialDiagram = diagramWithFlow,
}: {
  selection: { type: 'node' | 'flow'; id: string };
  initialDiagram?: () => Diagram;
}) {
  const [diagram, setDiagram] = useState(initialDiagram);

  const actions: PropertiesPanelActions = {
    renameNode: vi.fn(),
    setNotes: (id, notes) => setDiagram((current) => ops.setNotes(current, id, notes)),
    addJobAsset: vi.fn(),
    setJobBalance: vi.fn(),
    setJobAssetActive: vi.fn(),
    addHolding: vi.fn(),
    updateHolding: vi.fn(),
    updateFlow: (id, patch) => setDiagram((current) => ops.updateFlow(current, id, patch)),
    executeFlow: vi.fn(),
    renameFrame: vi.fn(),
  };

  return <PropertiesPanel diagram={diagram} selection={selection} actions={actions} />;
}

describe('notes', () => {
  it('is a box a running log fits in, not a single line', async () => {
    const user = userEvent.setup();
    render(<StatefulPanel selection={{ type: 'node', id: 'a1' }} />);

    const notes = screen.getByRole('textbox', { name: 'Notes' });
    // The real notes on this document are logs appended over weeks — "10/07 -
    // 2000  10/08 - 2011.90" on one account. A line control takes none of the
    // breaks that make one readable, and shows one entry at a time.
    expect(notes.tagName).toBe('TEXTAREA');

    await user.type(notes, '10/07 - 2000{Enter}10/08 - 2011.90');

    expect(notes).toHaveValue('10/07 - 2000\n10/08 - 2011.90');
  });

  it('gives a flow the same box, not a lesser one', async () => {
    const user = userEvent.setup();
    render(<StatefulPanel selection={{ type: 'flow', id: 'f1' }} />);

    const notes = screen.getByRole('textbox', { name: 'Notes' });
    expect(notes.tagName).toBe('TEXTAREA');

    await user.type(notes, 'paid late{Enter}chased twice');

    expect(notes).toHaveValue('paid late\nchased twice');
  });
});

describe('flow settlement', () => {
  it('does not repeat the successful settlement outcome below Execute', () => {
    render(
      <StatefulPanel
        selection={{ type: 'flow', id: 'f1' }}
        initialDiagram={diagramWithSettleableFlow}
      />,
    );

    expect(screen.queryByText(/Moves .* and leaves the flow empty\./)).not.toBeInTheDocument();
  });
});

describe('asset editors', () => {
  it.each([
    ['job', { type: 'node' as const, id: 'j1' }],
    ['account', { type: 'node' as const, id: 'a1' }],
  ])('places Add asset before the %s asset grid', (_, selection) => {
    render(<StatefulPanel selection={selection} />);

    const addAsset = screen.getByText('Add asset');
    const asset = screen.getByRole('button', { name: 'USD' });

    expect(addAsset.compareDocumentPosition(asset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    ['job', { type: 'node' as const, id: 'j1' }],
    ['account', { type: 'node' as const, id: 'a1' }],
  ])('keeps the %s asset draft labelled after its controls share one row', (_, selection) => {
    render(<StatefulPanel selection={selection} />);

    expect(screen.getByRole('textbox', { name: 'Add asset' })).toBeInTheDocument();
  });

  it('marks an over-allocated balance at its ticker and retains the allocation detail', () => {
    render(<StatefulPanel selection={{ type: 'node', id: 'j1' }} />);

    const ticker = screen.getByRole('button', { name: 'USD' });
    expect(ticker).toHaveClass(styles.assetOverAllocated);
    expect(ticker).toHaveAttribute('title', expect.stringContaining('promise'));
  });

  /*
   * The colour is not the warning on its own. Anybody who cannot separate red
   * from grey reads the row as ordinary, and a balance promising more than it
   * holds is the one thing on this panel that must not go quietly.
   */
  it('says over in words on the balance that does not add up, and only on that one', () => {
    render(<StatefulPanel selection={{ type: 'node', id: 'j1' }} />);

    const flags = screen.getAllByText('over');
    expect(flags).toHaveLength(1);
    expect(flags[0].closest('div')).toContainElement(screen.getByRole('button', { name: 'USD' }));
  });

  it('leaves a balance that adds up without the flag', () => {
    render(<StatefulPanel selection={{ type: 'node', id: 'a1' }} />);

    expect(screen.queryByText('over')).not.toBeInTheDocument();
  });
});
