import { useEffect, useMemo, useRef, useState } from 'react';

import { useFinanceData } from '@/features/finance/hooks/useFinanceData';
import { formatAmount } from '@/features/finance/lib/format';
import { NODE_SIZE } from '@/features/finance/lib/geometry';
import { describeConnectError } from '@/features/finance/lib/operations';
import {
  selectAvailable,
  selectHoldingsOfAccount,
  selectInTransit,
  type AssetTotal,
} from '@/features/finance/lib/summary';
import type { Anchor, NodeId, Point } from '@/features/finance/model/types';
import { DiagramTabs } from '@/features/finance/ui/DiagramTabs';
import { FlowCanvas, type Selection } from '@/features/finance/ui/FlowCanvas';
import {
  PropertiesPanel,
  type PropertiesPanelActions,
} from '@/features/finance/ui/PropertiesPanel';
import { Button } from '@/shared/ui/Button';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';

import styles from './ui/FinancePage.module.css';

/**
 * Jobs and accounts sit on a wide grid; each row leaves room underneath for the
 * holdings its accounts will grow, so nothing lands on top of anything else.
 */
function nextPosition(topLevelCount: number) {
  return { x: 80 + (topLevelCount % 4) * 260, y: 60 + Math.floor(topLevelCount / 4) * 420 };
}

/** Holdings stack below their own account rather than beside it, clear of each other. */
function holdingPosition(accountPosition: Point, siblings: number) {
  const step = NODE_SIZE.holding.height + 12;
  return {
    x: accountPosition.x,
    y: accountPosition.y + NODE_SIZE.account.height + 32 + siblings * step,
  };
}

export function FinancePage() {
  const finance = useFinanceData();
  const { diagram } = finance;

  const [selection, setSelection] = useState<Selection>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<{ nodeId: NodeId; anchor: Anchor } | null>(null);
  const [frameMode, setFrameMode] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const available = useMemo(() => selectAvailable(diagram), [diagram]);
  const inTransit = useMemo(() => selectInTransit(diagram), [diagram]);
  // Holdings are placed relative to their account, so they do not shift this grid.
  const topLevelCount = diagram.nodeOrder.filter(
    (id) => diagram.nodes[id]?.kind !== 'holding',
  ).length;

  function stopConnecting() {
    setConnectMode(false);
    setConnectFrom(null);
  }

  async function handleAnchorClick(nodeId: NodeId, anchor: Anchor) {
    setMessage(null);

    if (!connectFrom) {
      setConnectFrom({ nodeId, anchor });
      return;
    }

    // Clicking the source again backs out of the pick.
    if (connectFrom.nodeId === nodeId) {
      setConnectFrom(null);
      return;
    }

    const result = await finance.connect({
      from: connectFrom.nodeId,
      to: nodeId,
      fromAnchor: connectFrom.anchor,
      toAnchor: anchor,
    });
    stopConnecting();
    if (!result.ok) setMessage(describeConnectError(result.error));
  }

  function handleDelete() {
    if (!selection) return;
    setMessage(null);
    if (selection.type === 'node') void finance.deleteNode(selection.id);
    else if (selection.type === 'frame') void finance.deleteFrame(selection.id);
    else void finance.deleteFlow(selection.id);
    setSelection(null);
  }

  function handleUndo() {
    setMessage(null);
    // What a step lands on may no longer contain what was selected.
    setSelection(null);
    void finance.undo();
  }

  function handleRedo() {
    setMessage(null);
    setSelection(null);
    void finance.redo();
  }

  const panelActions: PropertiesPanelActions = {
    renameNode: (id, name) => void finance.renameNode(id, name),
    setNotes: (id, notes) => void finance.setNotes(id, notes),
    addJobAsset: (jobId, asset) => void finance.addJobAsset(jobId, asset),
    setJobBalance: (jobId, asset, amount) => void finance.setJobBalance(jobId, asset, amount),
    setJobAssetActive: (jobId, asset, active) =>
      void finance.setJobAssetActive(jobId, asset, active),
    addHolding: async (accountId, asset) => {
      setMessage(null);
      const account = diagram.nodes[accountId];
      const base = account?.position ?? { x: 0, y: 0 };
      const siblings = selectHoldingsOfAccount(diagram, accountId).length;
      const result = await finance.addHolding(accountId, asset, holdingPosition(base, siblings));
      if (!result.ok) {
        setMessage(
          result.error.code === 'asset-already-held'
            ? `This account already holds ${result.error.asset}.`
            : 'That account no longer exists.',
        );
      }
    },
    updateHolding: (id, patch) => void finance.updateHolding(id, patch),
    updateFlow: (id, patch) => void finance.updateFlow(id, patch),
    renameFrame: (id, name) => void finance.renameFrame(id, name),
  };

  // Held in a ref so the listener is bound once instead of on every render.
  const shortcuts = useRef({ undo: handleUndo, redo: handleRedo });
  shortcuts.current = { undo: handleUndo, redo: handleRedo };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;

      // Fields keep their own undo; taking it would be worse than not having one.
      // Guard the type: a key event can be aimed at document or window, and
      // closest() only exists on elements.
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }

      event.preventDefault();
      if (event.shiftKey) shortcuts.current.redo();
      else shortcuts.current.undo();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const problem = message ?? (finance.isError ? 'Could not load the diagram from storage.' : null);
  const status = finance.isSaving ? 'Saving…' : finance.isFetching ? 'Loading…' : 'Saved';
  const hint = frameMode
    ? 'Drag out a rectangle to frame what it encloses.'
    : !connectMode
      ? 'Drag nodes to arrange them, the canvas to move around, and scroll to zoom.'
      : connectFrom
        ? 'Now pick the anchor it flows into.'
        : 'Pick the anchor the money leaves from.';

  return (
    <section className={styles.page} aria-labelledby="finance-title">
      <PageHeader
        title="Finance"
        subtitle="Map where money comes from, where it sits, and where it moves."
        titleId="finance-title"
      />

      <DiagramTabs
        diagrams={finance.diagrams}
        activeId={finance.activeDiagramId}
        onSelect={(id) => {
          setSelection(null);
          void finance.selectDiagram(id);
        }}
        onAdd={() => {
          setSelection(null);
          void finance.addDiagram();
        }}
        onDuplicate={(id) => void finance.duplicateDiagram(id)}
        onRename={(id, name) => void finance.renameDiagram(id, name)}
        onDelete={(id) => {
          setSelection(null);
          void finance.deleteDiagram(id);
        }}
      />

      <Panel>
        <div className={styles.toolbar}>
          <div className={styles.toolGroup}>
            <Button onClick={() => void finance.addJob(nextPosition(topLevelCount))}>
              Add job
            </Button>
            <Button onClick={() => void finance.addAccount(nextPosition(topLevelCount))}>
              Add account
            </Button>
          </div>

          <div className={styles.toolGroup}>
            <Button disabled={!finance.canUndo} title="Undo (Ctrl+Z)" onClick={handleUndo}>
              Undo
            </Button>
            <Button disabled={!finance.canRedo} title="Redo (Ctrl+Shift+Z)" onClick={handleRedo}>
              Redo
            </Button>
          </div>

          <div className={styles.toolGroup}>
            <Button
              variant={connectMode ? 'primary' : 'secondary'}
              onClick={() => {
                setMessage(null);
                setFrameMode(false);
                if (connectMode) stopConnecting();
                else setConnectMode(true);
              }}
            >
              {connectMode ? 'Cancel connect' : 'Connect'}
            </Button>
            <Button
              variant={frameMode ? 'primary' : 'secondary'}
              onClick={() => {
                setMessage(null);
                stopConnecting();
                setFrameMode((current) => !current);
              }}
            >
              {frameMode ? 'Cancel frame' : 'Frame'}
            </Button>
            <Button variant="danger" disabled={!selection} onClick={handleDelete}>
              Delete
            </Button>
          </div>

          <span className={`${styles.hint} ${styles.spacer}`}>{hint}</span>
          <span className={styles.status}>{status}</span>
        </div>

        {/* Sits with the actions that caused it, and only when there is one. */}
        {problem ? (
          <p className={styles.error} role="alert">
            {problem}
          </p>
        ) : null}
      </Panel>

      <div className={styles.workspace}>
        <FlowCanvas
          diagram={diagram}
          selection={selection}
          connectMode={connectMode}
          connectFrom={connectFrom}
          frameMode={frameMode}
          onSelect={setSelection}
          onMoveNode={(id, position) => void finance.moveNode(id, position)}
          onAnchorClick={(nodeId, anchor) => void handleAnchorClick(nodeId, anchor)}
          onCreateFrame={(rect) => {
            // One frame per press of the button, so the mode does not linger and
            // turn the next pan into another rectangle.
            setFrameMode(false);
            void finance.addFrame(
              { x: rect.left, y: rect.top },
              { width: rect.width, height: rect.height },
            );
          }}
          onMoveFrame={(id, position) => void finance.moveFrame(id, position)}
          onResizeFrame={(id, position, size) => void finance.resizeFrame(id, position, size)}
        />

        <div className={styles.side}>
          <Panel aria-label="Selected item">
            <PropertiesPanel diagram={diagram} selection={selection} actions={panelActions} />
          </Panel>

          <Panel className={styles.summary} aria-label="Diagram totals">
            <SummarySection title="Available" totals={available} />
            <SummarySection title="In transit" totals={inTransit} />
          </Panel>
        </div>
      </div>
    </section>
  );
}

function SummarySection({ title, totals }: { title: string; totals: AssetTotal[] }) {
  return (
    <section className={styles.summarySection}>
      <h2 className={styles.summaryTitle}>{title}</h2>
      {totals.length ? (
        <div className={styles.summaryItems}>
          {totals.map((total) => (
            <div key={total.asset} className={styles.summaryItem}>
              <span className={styles.summaryAsset}>{total.asset}</span>
              <span className={styles.summaryValue}>{formatAmount(total.amount)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.summaryEmpty}>Nothing yet.</p>
      )}
    </section>
  );
}
