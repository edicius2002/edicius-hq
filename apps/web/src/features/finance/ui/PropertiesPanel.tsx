import { useState, type ReactNode } from 'react';

import { computeTransfer, isOverdrawnByFees } from '@/features/finance/lib/fees';
import { formatAmount, formatAssetAmount } from '@/features/finance/lib/format';
import { selectAccountSummary, selectHoldingsOfAccount } from '@/features/finance/lib/summary';
import type {
  AccountNode,
  Diagram,
  Fee,
  FeeType,
  FinanceNode,
  Flow,
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

/** Empty input means "no amount", which is a different state from zero. */
function toAmount(raw: string): number | null {
  if (raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function feeInput(fee: Fee | null): string {
  return fee ? String(fee.value) : '';
}

function buildFee(raw: string, type: FeeType): Fee | null {
  const value = toAmount(raw);
  if (value === null || value === 0) return null;
  return {
    value: type === 'percent' ? Math.min(Math.max(value, 0), 100) : Math.max(value, 0),
    type,
  };
}

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
};

type PropertiesPanelProps = {
  diagram: Diagram;
  selection: { type: 'node' | 'flow'; id: string } | null;
  actions: PropertiesPanelActions;
};

export function PropertiesPanel({ diagram, selection, actions }: PropertiesPanelProps) {
  if (!selection) {
    return (
      <div className={styles.empty}>
        <span>Select a node or a flow to edit it.</span>
      </div>
    );
  }

  if (selection.type === 'flow') {
    const flow = diagram.flows[selection.id];
    if (!flow) return <div className={styles.empty}>That flow is gone.</div>;
    return <FlowFields diagram={diagram} flow={flow} actions={actions} />;
  }

  const node = diagram.nodes[selection.id];
  if (!node) return <div className={styles.empty}>That node is gone.</div>;

  return (
    <div className={styles.panel}>
      <Header kind={node.kind} />
      <Field label="Name">
        <input
          className={styles.input}
          value={node.name}
          onChange={(event) => actions.renameNode(node.id, event.target.value)}
        />
      </Field>

      {node.kind === 'job' ? <JobFields node={node} actions={actions} /> : null}
      {node.kind === 'account' ? (
        <AccountFields diagram={diagram} node={node} actions={actions} />
      ) : null}
      {node.kind === 'holding' ? <HoldingFields node={node} actions={actions} /> : null}

      <Field label="Notes">
        <input
          className={styles.input}
          value={node.notes}
          placeholder="Optional"
          onChange={(event) => actions.setNotes(node.id, event.target.value)}
        />
      </Field>
    </div>
  );
}

function Header({ kind }: { kind: FinanceNode['kind'] }) {
  const badge = BADGE[kind];
  return (
    <div className={styles.header}>
      <span
        className={styles.badge}
        style={{ '--badge-color': badge.color, '--badge-bg': badge.bg } as React.CSSProperties}
      >
        {badge.label}
      </span>
    </div>
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

/** Shared editor for the list of assets a job is paid in. */
function JobFields({ node, actions }: { node: JobNode; actions: PropertiesPanelActions }) {
  const [draft, setDraft] = useState('');

  function addAsset() {
    if (!draft.trim()) return;
    actions.addJobAsset(node.id, draft);
    setDraft('');
  }

  return (
    <>
      <h3 className={styles.sectionTitle}>Paid in</h3>
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
              <input
                className={styles.input}
                type="number"
                step="0.01"
                value={balance.amount ?? ''}
                placeholder="0.00"
                disabled={!balance.active}
                onChange={(event) =>
                  actions.setJobBalance(node.id, balance.asset, toAmount(event.target.value))
                }
              />
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.hint}>No assets yet.</p>
      )}

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
              <input
                className={styles.input}
                type="number"
                step="0.01"
                value={holding.amount ?? ''}
                placeholder="0.00"
                disabled={!holding.active}
                onChange={(event) =>
                  actions.updateHolding(holding.id, { amount: toAmount(event.target.value) })
                }
              />
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.hint}>
          No assets yet. Add one to give this account something to hold.
        </p>
      )}

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

      <h3 className={styles.sectionTitle}>Movement</h3>
      <div className={styles.chain}>
        <div className={styles.chainRow}>
          <span>In</span>
          <span>
            {summary.incoming.count} ·{' '}
            {summary.incoming.totals.map((t) => formatAssetAmount(t.asset, t.amount)).join(', ') ||
              '—'}
          </span>
        </div>
        <div className={styles.chainRow}>
          <span>Out</span>
          <span>
            {summary.outgoing.count} ·{' '}
            {summary.outgoing.totals.map((t) => formatAssetAmount(t.asset, t.amount)).join(', ') ||
              '—'}
          </span>
        </div>
      </div>
      <p className={styles.hint}>Out counts what left; in counts what arrived after fees.</p>
    </>
  );
}

function HoldingFields({ node, actions }: { node: HoldingNode; actions: PropertiesPanelActions }) {
  return (
    <>
      <Field label={`Amount (${node.asset})`}>
        <input
          className={styles.input}
          type="number"
          step="0.01"
          value={node.amount ?? ''}
          placeholder="0.00"
          onChange={(event) =>
            actions.updateHolding(node.id, { amount: toAmount(event.target.value) })
          }
        />
      </Field>

      <h3 className={styles.sectionTitle}>Fees</h3>
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
      <p className={styles.hint}>
        A transfer takes the source&apos;s out fee first, then the destination&apos;s in fee, each
        from what is left.
      </p>
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
        <input
          className={styles.input}
          type="number"
          step="0.01"
          min="0"
          max={type === 'percent' ? 100 : undefined}
          value={feeInput(fee)}
          placeholder="0"
          onChange={(event) => onChange(buildFee(event.target.value, type))}
        />
        <select
          className={styles.select}
          value={type}
          onChange={(event) => onChange(buildFee(feeInput(fee), event.target.value as FeeType))}
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
        <input
          className={styles.input}
          type="number"
          step="0.01"
          value={flow.amount ?? ''}
          placeholder="0.00"
          onChange={(event) =>
            actions.updateFlow(flow.id, { amount: toAmount(event.target.value) })
          }
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

      <Field label="Label">
        <input
          className={styles.input}
          value={flow.label}
          placeholder="Optional"
          onChange={(event) => actions.updateFlow(flow.id, { label: event.target.value })}
        />
      </Field>

      <Field label="Notes">
        <input
          className={styles.input}
          value={flow.notes}
          placeholder="Optional"
          onChange={(event) => actions.updateFlow(flow.id, { notes: event.target.value })}
        />
      </Field>
    </div>
  );
}
