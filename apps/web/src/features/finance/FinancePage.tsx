import { useMemo, useState } from 'react';

import { useFinanceData } from '@/features/finance/hooks/useFinanceData';
import { formatAmount } from '@/features/finance/lib/format';
import { describeConnectError } from '@/features/finance/lib/operations';
import { selectAvailable, selectInTransit, type AssetTotal } from '@/features/finance/lib/summary';
import type { Anchor, NodeId } from '@/features/finance/model/types';
import { FlowCanvas, type Selection } from '@/features/finance/ui/FlowCanvas';
import { Button } from '@/shared/ui/Button';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Panel } from '@/shared/ui/Panel';

import styles from './ui/FinancePage.module.css';

/** Stagger new nodes so they do not pile onto one spot. */
function nextPosition(count: number) {
  return { x: 80 + (count % 4) * 240, y: 80 + Math.floor(count / 4) * 150 };
}

export function FinancePage() {
  const finance = useFinanceData();
  const { diagram } = finance;

  const [selection, setSelection] = useState<Selection>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<{ nodeId: NodeId; anchor: Anchor } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const available = useMemo(() => selectAvailable(diagram), [diagram]);
  const inTransit = useMemo(() => selectInTransit(diagram), [diagram]);
  const nodeCount = diagram.nodeOrder.length;

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
    else void finance.deleteFlow(selection.id);
    setSelection(null);
  }

  const status = finance.isSaving ? 'Saving…' : finance.isFetching ? 'Loading…' : 'Saved';
  const hint = !connectMode
    ? 'Drag nodes to arrange them.'
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

      <Panel>
        <div className={styles.toolbar}>
          <div className={styles.toolGroup}>
            <Button onClick={() => void finance.addJob(nextPosition(nodeCount))}>Add job</Button>
            <Button onClick={() => void finance.addAccount(nextPosition(nodeCount))}>
              Add account
            </Button>
          </div>

          <div className={styles.toolGroup}>
            <Button
              variant={connectMode ? 'primary' : 'secondary'}
              onClick={() => {
                setMessage(null);
                if (connectMode) stopConnecting();
                else setConnectMode(true);
              }}
            >
              {connectMode ? 'Cancel connect' : 'Connect'}
            </Button>
            <Button variant="danger" disabled={!selection} onClick={handleDelete}>
              Delete
            </Button>
          </div>

          <span className={`${styles.hint} ${styles.spacer}`}>{hint}</span>
          <span className={styles.status}>{status}</span>
        </div>
      </Panel>

      <p className={styles.error} role="alert">
        {message ?? (finance.isError ? 'Could not load the diagram from storage.' : '')}
      </p>

      <div className={styles.workspace}>
        <FlowCanvas
          diagram={diagram}
          selection={selection}
          connectMode={connectMode}
          connectFrom={connectFrom}
          onSelect={setSelection}
          onMoveNode={(id, position) => void finance.moveNode(id, position)}
          onAnchorClick={(nodeId, anchor) => void handleAnchorClick(nodeId, anchor)}
        />

        <Panel className={styles.summary} aria-label="Diagram totals">
          <SummarySection title="Available" totals={available} />
          <SummarySection title="In transit" totals={inTransit} />
        </Panel>
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
