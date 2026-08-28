import { useState, type ReactNode } from 'react';

import { canExecuteFlow, describeExecuteError } from '@/features/finance/lib/execute';
import { AmountInput } from '@/features/finance/ui/AmountInput';
import { computeTransfer, isOverdrawnByFees } from '@/features/finance/lib/fees';
import { formatAmount, formatAssetAmount } from '@/shared/lib/money';
import { frameMembers } from '@/features/finance/lib/frames';
import {
  selectAccountSummary,
  selectAllocation,
  selectFrameSummary,
  selectHoldingsOfAccount,
} from '@/features/finance/lib/summary';
import type {
  AccountNode,
  Diagram,
  Fee,
  FeeType,
  FinanceNode,
  Flow,
  Frame,
  HoldingNode,
  JobNode,
} from '@/features/finance/model/types';
import { Button } from '@/shared/ui/Button';

import styles from './PropertiesPanel.module.css';

const BADGE: Record<FinanceNode['kind'], { label: string; color: string; bg: string }> = {
  job: { label: 'Job', color: 'var(--color-accent)', bg: 'rgba(214, 166, 93, 0.14)' },
  account: { label: 'Account', color: '#60a5fa', bg: 'rgba(96, 165, 250, 0.14)' },
  holding: { label: 'Holding', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.14)' },
};

export type PropertiesPanelActions = {
  renameNode: (id: string, name: string) => void;
  setNotes: (id: string, notes: string) => void;
  addJobAsset: (jobId: string, asset: string) => void;
  setJobBalance: (jobId: string, asset: string, amount: number | null) => void;
  setJobAssetActive: (jobId: string, asset: string, active: boolean) => void;
  addHolding: (accountId: string, asset: string) => void;
  updateHolding: (
    id: string,
    patch: Partial<Pick<HoldingNode, 'amount' | 'fees' | 'active'>>,
  ) => void;
  updateFlow: (id: string, patch: Partial<Pick<Flow, 'amount' | 'label' | 'notes'>>) => void;
  executeFlow: (id: string) => void;
  renameFrame: (id: string, name: string) => void;
};

type PropertiesPanelProps = {
  diagram: Diagram;
  selection: { type: 'node' | 'flow' | 'frame'; id: string } | null;
  actions: PropertiesPanelActions;
};

export function PropertiesPanel({ diagram, selection, actions }: PropertiesPanelProps) {
  if (!selection) {
    return (
      <div className={styles.empty}>
        <span>Select a node, a flow or a frame to edit it.</span>
      </div>
    );
  }

  if (selection.type === 'flow') {
    const flow = diagram.flows[selection.id];
    if (!flow) return <div className={styles.empty}>That flow is gone.</div>;
    return <FlowFields diagram={diagram} flow={flow} actions={actions} />;
  }

  if (selection.type === 'frame') {
    const frame = diagram.frames[selection.id];
    if (!frame) return <div className={styles.empty}>That frame is gone.</div>;
    return <FrameFields diagram={diagram} frame={frame} actions={actions} />;
  }

  const node = diagram.nodes[selection.id];
  if (!node) return <div className={styles.empty}>That node is gone.</div>;

  return (
    <div className={styles.panel}>
      <Header kind={node.kind}>
        {/* The badge already says what this is, so a "Name" label above the box
            beside it named the same thing twice and cost a row of a panel with
            a fixed height. The accessible name moves onto the input itself,
            which is what a screen reader reads anyway. */}
        <input
          className={`${styles.input} ${styles.nameInput}`}
          value={node.name}
          aria-label="Name"
          placeholder="Name"
          onChange={(event) => actions.renameNode(node.id, event.target.value)}
        />
      </Header>

      {node.kind === 'job' ? <JobFields diagram={diagram} node={node} actions={actions} /> : null}
      {node.kind === 'account' ? (
        <AccountFields diagram={diagram} node={node} actions={actions} />
      ) : null}
      {node.kind === 'holding' ? <HoldingFields node={node} actions={actions} /> : null}

      <Field label="Notes">
        <NotesInput value={node.notes} onChange={(notes) => actions.setNotes(node.id, notes)} />
      </Field>
    </div>
  );
}

/**
 * A frame is named and nothing else. What it holds is not a field: it is worked
 * out from what sits inside it, so the panel reports it rather than offering it
 * for editing.
 */
function FrameFields({
  diagram,
  frame,
  actions,
}: {
  diagram: Diagram;
  frame: Frame;
  actions: PropertiesPanelActions;
}) {
  const summary = selectFrameSummary(diagram, frameMembers(diagram, frame.id));

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span
          className={styles.badge}
          style={
            {
              '--badge-color': 'var(--color-muted)',
              '--badge-bg': 'rgba(184, 172, 160, 0.14)',
            } as React.CSSProperties
          }
        >
          Frame
        </span>
      </div>

      <Field label="Name">
        <input
          className={styles.input}
          value={frame.name}
          onChange={(event) => actions.renameFrame(frame.id, event.target.value)}
        />
      </Field>

      <h3 className={styles.sectionTitle}>Holds</h3>
      <p className={styles.hint}>
        {summary.nodeCount === 0
          ? 'Nothing yet. Drag a node inside and it joins.'
          : `${summary.nodeCount} ${summary.nodeCount === 1 ? 'node' : 'nodes'}, by where they sit.`}
      </p>

      {summary.totals.length ? (
        <div className={styles.assets}>
          {summary.totals.map((total) => (
            <div key={total.asset} className={styles.chainRow}>
              <span>{total.asset}</span>
              <strong>{formatAmount(total.amount)}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Header({ kind, children }: { kind: FinanceNode['kind']; children?: ReactNode }) {
  const badge = BADGE[kind];
  return (
    <div className={styles.header}>
      <span
        className={styles.badge}
        style={{ '--badge-color': badge.color, '--badge-bg': badge.bg } as React.CSSProperties}
      >
        {badge.label}
      </span>
      {children}
    </div>
  );
}

/**
 * What share of a balance is still free.
 *
 * Silent until something is actually promised: with no outgoing flows the answer
 * is always "all of it", and a chip that always says 100% is noise rather than
 * information. The pair behind it — what is left over what there was — is on the
 * chip's title, because the panel has a fixed height and this is the second
 * question, not the first.
 */
function Allocated({
  diagram,
  nodeId,
  asset,
}: {
  diagram: Diagram;
  nodeId: string;
  asset: string;
}) {
  const allocation = selectAllocation(diagram, nodeId, asset);
  if (!allocation || allocation.committed <= 0) return null;

  return (
    <span
      className={`${styles.allocated} ${allocation.exceeded ? styles.allocatedOver : ''}`}
      title={
        allocation.exceeded
          ? `Flows out of this balance promise ${formatAmount(allocation.committed)} of ${formatAmount(allocation.total)} — ${formatAmount(-allocation.remaining)} more than it holds.`
          : `${formatAmount(allocation.remaining)} free of ${formatAmount(allocation.total)}`
      }
    >
      {allocation.exceeded ? 'over' : `${Math.round(allocation.pct)}%`}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={styles.field}>
      {label}
      {children}
    </label>
  );
}

/**
 * Notes, for a node or for a flow.
 *
 * A box rather than a line, because of what people actually write in it. On the
 * real document the notes are running logs — `10/07 - 2000  10/08 - 2011.90`,
 * `07/08 - USD +785.58` — entries appended over weeks to a field that showed
 * one line at a time and scrolled sideways to read any of it.
 *
 * Three lines to start and a grip to take it further: how much a note has to
 * say is the reader's business, not the layout's. The panel holds a fixed
 * height and scrolls what does not fit, so a note dragged tall costs the panel
 * a scrollbar rather than costing the canvas its width.
 */
function NotesInput({ value, onChange }: { value: string; onChange: (notes: string) => void }) {
  return (
    <textarea
      className={styles.notes}
      value={value}
      rows={3}
      placeholder="Optional"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** Shared editor for the list of assets a job is paid in. */
function JobFields({
  diagram,
  node,
  actions,
}: {
  diagram: Diagram;
  node: JobNode;
  actions: PropertiesPanelActions;
}) {
  const [draft, setDraft] = useState('');

  function addAsset() {
    if (!draft.trim()) return;
    actions.addJobAsset(node.id, draft);
    setDraft('');
  }

  return (
    <>
      <h3 className={styles.sectionTitle}>Paid in</h3>
      <div className={styles.row}>
        <span className={`${styles.field} ${styles.rowGrow}`}>
          Add asset
          <input
            className={styles.input}
            value={draft}
            placeholder="USD"
            maxLength={8}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addAsset();
            }}
          />
        </span>
        <Button onClick={addAsset}>Add</Button>
      </div>
      {node.balances.length ? (
        <div className={styles.assets}>
          {node.balances.map((balance) => (
            <div key={balance.asset} className={styles.asset}>
              <button
                type="button"
                className={`${styles.assetToggle} ${balance.active ? styles.assetActive : ''}`}
                aria-pressed={balance.active}
                title={
                  balance.active ? `Switch ${balance.asset} off` : `Switch ${balance.asset} on`
                }
                onClick={() => actions.setJobAssetActive(node.id, balance.asset, !balance.active)}
              >
                {balance.asset}
              </button>
              <AmountInput
                className={styles.input}
                value={balance.amount}
                placeholder="0,00"
                disabled={!balance.active}
                onChange={(amount) => actions.setJobBalance(node.id, balance.asset, amount)}
              />
              <Allocated diagram={diagram} nodeId={node.id} asset={balance.asset} />
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.hint}>No assets yet.</p>
      )}

      <p className={styles.hint}>
        Switching an asset off keeps its amount, so switching it back on restores it.
      </p>
    </>
  );
}

function AccountFields({
  diagram,
  node,
  actions,
}: {
  diagram: Diagram;
  node: AccountNode;
  actions: PropertiesPanelActions;
}) {
  const [draft, setDraft] = useState('');
  const holdings = selectHoldingsOfAccount(diagram, node.id);
  const summary = selectAccountSummary(diagram, node.id);

  function addAsset() {
    if (!draft.trim()) return;
    actions.addHolding(node.id, draft);
    setDraft('');
  }

  return (
    <>
      <h3 className={styles.sectionTitle}>Assets held</h3>
      <div className={styles.row}>
        <span className={`${styles.field} ${styles.rowGrow}`}>
          Add asset
          <input
            className={styles.input}
            value={draft}
            placeholder="USD"
            maxLength={8}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addAsset();
            }}
          />
        </span>
        <Button onClick={addAsset}>Add</Button>
      </div>
      {holdings.length ? (
        <div className={styles.assets}>
          {holdings.map((holding) => (
            <div key={holding.id} className={styles.asset}>
              <button
                type="button"
                className={`${styles.assetToggle} ${holding.active ? styles.assetActive : ''}`}
                aria-pressed={holding.active}
                title={
                  holding.active ? `Switch ${holding.asset} off` : `Switch ${holding.asset} on`
                }
                onClick={() => actions.updateHolding(holding.id, { active: !holding.active })}
              >
                {holding.asset}
              </button>
              <AmountInput
                className={styles.input}
                value={holding.amount}
                placeholder="0,00"
                disabled={!holding.active}
                onChange={(amount) => actions.updateHolding(holding.id, { amount })}
              />
              <Allocated diagram={diagram} nodeId={holding.id} asset={holding.asset} />
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.hint}>
          No assets yet. Add one to give this account something to hold.
        </p>
      )}

      <h3 className={styles.sectionTitle}>Movement</h3>
      {/* In and out are one comparison, not two facts, and side by side is how a
          comparison reads. Stacked they also cost a row the fixed panel does not
          have to spare. */}
      <div className={styles.movement}>
        <div className={`${styles.chain} ${styles.movementCard}`}>
          <span className={styles.movementLabel}>In</span>
          <span>
            {summary.incoming.count} ·{' '}
            {summary.incoming.totals.map((t) => formatAssetAmount(t.asset, t.amount)).join(', ') ||
              '—'}
          </span>
        </div>
        <div className={`${styles.chain} ${styles.movementCard}`}>
          <span className={styles.movementLabel}>Out</span>
          <span>
            {summary.outgoing.count} ·{' '}
            {summary.outgoing.totals.map((t) => formatAssetAmount(t.asset, t.amount)).join(', ') ||
              '—'}
          </span>
        </div>
      </div>
    </>
  );
}

function HoldingFields({ node, actions }: { node: HoldingNode; actions: PropertiesPanelActions }) {
  return (
    <>
      <Field label={`Amount (${node.asset})`}>
        <AmountInput
          className={styles.input}
          value={node.amount}
          placeholder="0,00"
          onChange={(amount) => actions.updateHolding(node.id, { amount })}
        />
      </Field>

      <h3 className={styles.sectionTitle}>Fees</h3>
      {/* Side by side: they are the two halves of one question — what a transfer
          costs leaving and what it costs arriving — and stacked they read as two
          unrelated settings that happen to be near each other. */}
      <div className={styles.feePair}>
        <FeeField
          label="Charged on the way out"
          fee={node.fees.out}
          onChange={(fee) => actions.updateHolding(node.id, { fees: { ...node.fees, out: fee } })}
        />
        <FeeField
          label="Charged on the way in"
          fee={node.fees.in}
          onChange={(fee) => actions.updateHolding(node.id, { fees: { ...node.fees, in: fee } })}
        />
      </div>
    </>
  );
}

function FeeField({
  label,
  fee,
  onChange,
}: {
  label: string;
  fee: Fee | null;
  onChange: (fee: Fee | null) => void;
}) {
  const type = fee?.type ?? 'percent';
  return (
    <span className={styles.field}>
      {label}
      <span className={styles.feeGrid}>
        <AmountInput
          className={styles.input}
          value={fee ? fee.value : null}
          placeholder="0"
          onChange={(value) => onChange(value === null ? null : { value, type })}
        />
        <select
          className={styles.select}
          value={type}
          /* The value is a number now, so changing the unit no longer sends it
             out to a string and back — which was the last thing keeping a
             second parser alive beside `parseAmount`. */
          onChange={(event) =>
            onChange(fee ? { value: fee.value, type: event.target.value as FeeType } : null)
          }
        >
          <option value="percent">%</option>
          <option value="fixed">flat</option>
        </select>
      </span>
    </span>
  );
}

function FlowFields({
  diagram,
  flow,
  actions,
}: {
  diagram: Diagram;
  flow: Flow;
  actions: PropertiesPanelActions;
}) {
  const source = diagram.nodes[flow.from];
  const target = diagram.nodes[flow.to];
  const breakdown = computeTransfer(flow.amount ?? 0, source, target);
  const overdrawn = isOverdrawnByFees(breakdown);
  const settle = canExecuteFlow(diagram, flow.id);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span
          className={styles.badge}
          style={
            {
              '--badge-color': 'rgb(253, 186, 116)',
              '--badge-bg': 'rgba(253, 186, 116, 0.14)',
            } as React.CSSProperties
          }
        >
          Flow
        </span>
      </div>

      <p className={styles.hint}>
        {source?.name} → {target?.name}
      </p>

      <Field label={`Amount (${flow.asset})`}>
        <AmountInput
          className={styles.input}
          value={flow.amount}
          placeholder="0,00"
          onChange={(amount) => actions.updateFlow(flow.id, { amount })}
        />
      </Field>

      {breakdown.steps.length ? (
        <>
          <h3 className={styles.sectionTitle}>After fees</h3>
          <div className={styles.chain}>
            <div className={styles.chainRow}>
              <span>Sent</span>
              <span>{formatAmount(breakdown.gross)}</span>
            </div>
            {breakdown.steps.map((step, index) => (
              <div key={`${step.direction}-${index}`} className={styles.chainRow}>
                <span className={styles.chainFee}>
                  {step.direction === 'out' ? 'Source fee' : 'Destination fee'}{' '}
                  {step.fee.type === 'percent'
                    ? `−${step.fee.value}%`
                    : `−${formatAmount(step.fee.value)}`}
                </span>
                <span>{formatAmount(step.net)}</span>
              </div>
            ))}
            <div className={styles.chainRow}>
              <span>Arrives</span>
              <span className={styles.chainNet}>{formatAmount(breakdown.net)}</span>
            </div>
          </div>
        </>
      ) : null}

      {overdrawn ? (
        <p className={styles.warning}>
          The fees are bigger than the amount, so this flow carries nothing and is left out of the
          totals.
        </p>
      ) : null}

      {/*
       * Carrying the flow out, not only describing it. The refusal is said in
       * words beside the button rather than left as a disabled control with
       * nothing to explain it — which is the whole difference between "you
       * cannot" and "you cannot, because".
       */}
      <div className={styles.settle}>
        <Button
          variant="primary"
          disabled={!settle.ok}
          onClick={() => actions.executeFlow(flow.id)}
        >
          Execute
        </Button>
        {settle.ok ? (
          <span className={styles.settleNote}>
            Moves {formatAmount(breakdown.net)} {flow.asset} and leaves the flow empty.
          </span>
        ) : (
          <span className={styles.settleBlocked}>{describeExecuteError(settle.error)}</span>
        )}
      </div>

      <Field label="Label">
        <input
          className={styles.input}
          value={flow.label}
          placeholder="Optional"
          onChange={(event) => actions.updateFlow(flow.id, { label: event.target.value })}
        />
      </Field>

      <Field label="Notes">
        <NotesInput
          value={flow.notes}
          onChange={(notes) => actions.updateFlow(flow.id, { notes })}
        />
      </Field>
    </div>
  );
}
