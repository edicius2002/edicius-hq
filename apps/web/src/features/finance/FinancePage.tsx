import { useEffect, useMemo, useRef, useState } from 'react';

import { useFinanceData } from '@/features/finance/hooks/useFinanceData';
import { formatAmount } from '@/shared/lib/money';
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
import { SaveStatus } from '@/shared/ui/SaveStatus';

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
  // A conflict is a choice, not a transient save failure: keep the document on
  // screen but stop every edit route until that choice has been made. The same
  // gate covers the initial fetch, whose placeholder must never be saved.
  const editsBlocked = finance.isFetching || finance.isError || finance.conflict !== null;

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
    if (editsBlocked) return;
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
    if (editsBlocked) return;
    if (!selection) return;
    setMessage(null);
    if (selection.type === 'node') void finance.deleteNode(selection.id);
    else if (selection.type === 'frame') void finance.deleteFrame(selection.id);
    else void finance.deleteFlow(selection.id);
    setSelection(null);
  }

  function handleUndo() {
    if (editsBlocked) return;
    setMessage(null);
    // What a step lands on may no longer contain what was selected.
    setSelection(null);
    void finance.undo();
  }

  function handleRedo() {
    if (editsBlocked) return;
    setMessage(null);
    setSelection(null);
    void finance.redo();
  }

  const panelActions: PropertiesPanelActions = {
    renameNode: (id, name) => {
      if (!editsBlocked) void finance.renameNode(id, name);
    },
    setNotes: (id, notes) => {
      if (!editsBlocked) void finance.setNotes(id, notes);
    },
    addJobAsset: (jobId, asset) => {
      if (!editsBlocked) void finance.addJobAsset(jobId, asset);
    },
    setJobBalance: (jobId, asset, amount) => {
      if (!editsBlocked) void finance.setJobBalance(jobId, asset, amount);
    },
    setJobAssetActive: (jobId, asset, active) => {
      if (!editsBlocked) void finance.setJobAssetActive(jobId, asset, active);
    },
    executeFlow: (id) => {
      if (editsBlocked) return;
      setMessage(null);
      void finance.executeFlow(id);
    },
    /*
     * Not an `async` handler: the prop returns void, so nothing awaits this and
     * a rejection had nowhere to go — a storage failure here left the panel
     * silent. Handling both arms explicitly is what makes that impossible.
     */
    addHolding: (accountId, asset) => {
      if (editsBlocked) return;
      setMessage(null);
      const account = diagram.nodes[accountId];
      const base = account?.position ?? { x: 0, y: 0 };
      const siblings = selectHoldingsOfAccount(diagram, accountId).length;

      void finance
        .addHolding(accountId, asset, holdingPosition(base, siblings))
        .then((result) => {
          if (result.ok) return;
          setMessage(
            result.error.code === 'asset-already-held'
              ? `This account already holds ${result.error.asset}.`
              : 'That account no longer exists.',
          );
        })
        .catch(() => setMessage('Could not add the holding. The change was not saved.'));
    },
    updateHolding: (id, patch) => {
      if (!editsBlocked) void finance.updateHolding(id, patch);
    },
    updateFlow: (id, patch) => {
      if (!editsBlocked) void finance.updateFlow(id, patch);
    },
    renameFrame: (id, name) => {
      if (!editsBlocked) void finance.renameFrame(id, name);
    },
  };

  // Held in a ref so the listener is bound once instead of on every render.
  const shortcuts = useRef({ undo: handleUndo, redo: handleRedo });
  useEffect(() => {
    shortcuts.current = { undo: handleUndo, redo: handleRedo };
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (editsBlocked) return;
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
  }, [editsBlocked]);

  const problem = message ?? (finance.isError ? 'Could not load the diagram from Supabase.' : null);
  const conflictMessage =
    "Finance changed in another session. Your unsaved version is still in this tab. Choose the Supabase version or deliberately replace it with this tab's version.";
  /*
   * Only while a mode is waiting on you. Idle, this said "Drag nodes to arrange
   * them, the canvas to move around, and scroll to zoom" — which a user with a
   * pointer on the canvas learns by moving it, and which at 676px was wider
   * than the 661px the bar had left, so it took a line of its own. The three
   * that remain say what the app is waiting for, which nothing else does.
   */
  const hint = frameMode
    ? 'Drag out a rectangle to frame what it encloses.'
    : !connectMode
      ? null
      : connectFrom
        ? 'Now pick the anchor it flows into.'
        : 'Pick the anchor the money leaves from.';

  const toolbar = (
    <div className={styles.toolbar}>
      <div className={styles.toolGroup}>
        <Button
          disabled={editsBlocked}
          onClick={() => void finance.addJob(nextPosition(topLevelCount))}
        >
          Add job
        </Button>
        <Button
          disabled={editsBlocked}
          onClick={() => void finance.addAccount(nextPosition(topLevelCount))}
        >
          Add account
        </Button>
      </div>

      <div className={styles.toolGroup}>
        <Button
          disabled={editsBlocked || !finance.canUndo}
          title="Undo (Ctrl+Z)"
          onClick={handleUndo}
        >
          Undo
        </Button>
        <Button
          disabled={editsBlocked || !finance.canRedo}
          title="Redo (Ctrl+Shift+Z)"
          onClick={handleRedo}
        >
          Redo
        </Button>
      </div>

      <div className={styles.toolGroup}>
        <Button
          variant={connectMode ? 'primary' : 'secondary'}
          disabled={editsBlocked}
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
          disabled={editsBlocked}
          onClick={() => {
            setMessage(null);
            stopConnecting();
            setFrameMode((current) => !current);
          }}
        >
          {frameMode ? 'Cancel frame' : 'Frame'}
        </Button>
        <Button variant="danger" disabled={editsBlocked || !selection} onClick={handleDelete}>
          Delete
        </Button>
      </div>
    </div>
  );

  return (
    <section className={styles.page} aria-labelledby="page-title">
      {/* The editing actions ride beside the title rather than in a panel of
          their own. Measured at 1139x802 before this: the page furniture above
          the canvas took 529px of a 791px viewport, so only 273px of diagram
          was ever on screen. The subtitle went for the same reason — it said
          what the page is to someone already looking at it. */}
      <PageHeader
        className={styles.header}
        beside={
          <div className={styles.tabsScroll} inert={editsBlocked || undefined}>
            <DiagramTabs
              diagrams={finance.diagrams}
              activeId={finance.activeDiagramId}
              onSelect={(id) => {
                if (editsBlocked) return;
                setSelection(null);
                void finance.selectDiagram(id);
              }}
              onAdd={() => {
                if (editsBlocked) return;
                setSelection(null);
                void finance.addDiagram();
              }}
              onDuplicate={(id) => {
                if (!editsBlocked) void finance.duplicateDiagram(id);
              }}
              onRename={(id, name) => {
                if (!editsBlocked) void finance.renameDiagram(id, name);
              }}
              onDelete={(id) => {
                if (editsBlocked) return;
                setSelection(null);
                void finance.deleteDiagram(id);
              }}
            />
          </div>
        }
        actions={<div className={styles.headerActions}>{toolbar}</div>}
      />

      {/* Sits with the actions that caused it, and only when there is one. */}
      {problem ? (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      ) : null}
      {finance.conflict ? (
        <div className={styles.error}>
          <p role="alert">{conflictMessage}</p>
          {finance.conflict.status === 'ready' ? (
            <div className={styles.toolGroup}>
              <Button onClick={finance.acceptRemote}>Use Supabase version</Button>
              <Button
                variant="danger"
                onClick={() => void finance.overwriteRemote().catch(() => undefined)}
              >
                Replace with this tab's version
              </Button>
            </div>
          ) : null}
          {finance.conflict.status === 'load-failed' ? (
            <Button onClick={() => void finance.refreshConflict()}>
              Retry loading Supabase version
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Nothing between the canvas and the panel beside it: with the bar gone
          the two columns start on the same line as well as ending on it. */}
      <div className={styles.workspace} inert={editsBlocked || undefined}>
        <FlowCanvas
          status={
            <>
              <SaveStatus
                state={finance.conflict ? 'failed' : finance.saveState}
                onRetry={finance.conflict ? undefined : finance.retrySave}
              />
              {/* On the canvas rather than above it: a hint that comes and goes
                  with a mode would otherwise push the canvas down mid-gesture,
                  and the alignment with the panel beside it with it. */}
              {hint ? <span className={styles.canvasHint}>{hint}</span> : null}
            </>
          }
          diagram={diagram}
          selection={selection}
          connectMode={connectMode}
          connectFrom={connectFrom}
          frameMode={frameMode}
          onSelect={setSelection}
          onMoveNode={(id, position) => {
            if (!editsBlocked) void finance.moveNode(id, position);
          }}
          onAnchorClick={(nodeId, anchor) => void handleAnchorClick(nodeId, anchor)}
          onCreateFrame={(rect) => {
            // One frame per press of the button, so the mode does not linger and
            // turn the next pan into another rectangle.
            setFrameMode(false);
            if (!editsBlocked) {
              void finance.addFrame(
                { x: rect.left, y: rect.top },
                { width: rect.width, height: rect.height },
              );
            }
          }}
          onMoveFrame={(id, position) => {
            if (!editsBlocked) void finance.moveFrame(id, position);
          }}
          onResizeFrame={(id, position, size) => {
            if (!editsBlocked) void finance.resizeFrame(id, position, size);
          }}
          onConnectModeChange={(active) => {
            if (editsBlocked) return;
            setMessage(null);
            setFrameMode(false);
            if (active) setConnectMode(true);
            else stopConnecting();
          }}
        />

        <div className={styles.side}>
          <Panel className={styles.properties} aria-label="Selected item">
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
