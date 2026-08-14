import { type CSSProperties, type PointerEvent } from 'react';

import { sizeOf, type NodeContent } from '@/features/finance/lib/geometry';
import { formatAmount } from '@/shared/lib/money';
import { ANCHORS, type Anchor, type FinanceNode } from '@/features/finance/model/types';

import styles from './FlowNode.module.css';

/** Kept in sync with the anchor fractions in geometry, in percent for CSS. */
const ANCHOR_OFFSETS: Record<Anchor, { left: string; top: string }> = {
  tl: { left: '0%', top: '0%' },
  t: { left: '50%', top: '0%' },
  tr: { left: '100%', top: '0%' },
  r: { left: '100%', top: '50%' },
  br: { left: '100%', top: '100%' },
  b: { left: '50%', top: '100%' },
  bl: { left: '0%', top: '100%' },
  l: { left: '0%', top: '50%' },
};

const KIND_COLOR: Record<FinanceNode['kind'], { color: string; bg: string }> = {
  job: { color: 'var(--color-accent)', bg: 'rgba(214, 166, 93, 0.09)' },
  account: { color: '#60a5fa', bg: 'rgba(96, 165, 250, 0.09)' },
  holding: { color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.08)' },
};

const KIND_LABEL: Record<FinanceNode['kind'], string> = {
  job: 'Job',
  account: 'Account',
  holding: 'Holding',
};

type FlowNodeProps = {
  node: FinanceNode;
  selected: boolean;
  connecting: boolean;
  isConnectSource: boolean;
  /** The canvas owns keyboard focus; this marks its currently chosen anchor. */
  keyboardAnchor?: Anchor;
  /**
   * How many rows this node will show. The box is sized from it, so the two
   * cannot disagree — a height derived from the kind alone left an account with
   * one asset carrying 26px of slack in a 116px box.
   */
  content: NodeContent;
  /** What an account is worth and how much has crossed it. */
  /**
   * Assets whose outgoing flows promise more than the balance holds.
   *
   * Passed in rather than derived here for the same reason `accountSummary` is:
   * the node draws, the canvas knows the diagram. An account's own totals are
   * already net of what is committed, so a negative reads as over-allocated by
   * itself — a job's do not, which is why this exists at all.
   */
  overAllocated?: ReadonlySet<string>;
  /**
   * Assets with outgoing flows, with what is left against what there was.
   *
   * Drawn on the node rather than left to the panel: how much of a balance is
   * still yours to move is the question the diagram exists to answer, and it
   * was the one thing you had to click to find out.
   */
  allocations?: readonly {
    asset: string;
    remaining: number;
    total: number;
    pct: number;
    exceeded: boolean;
  }[];
  accountSummary?: {
    remaining: { asset: string; amount: number }[];
    incoming: { count: number };
    outgoing: { count: number };
  };
  onSelect: () => void;
  onDragStart: (event: PointerEvent<HTMLElement>) => void;
  onAnchorClick: (anchor: Anchor) => void;
};

function feeLabel(fee: { value: number; type: 'percent' | 'fixed' } | null): string | null {
  if (!fee || fee.value === 0) return null;
  return fee.type === 'percent' ? `${fee.value}%` : formatAmount(fee.value);
}

export function FlowNode({
  node,
  selected,
  connecting,
  isConnectSource,
  keyboardAnchor,
  content,
  accountSummary,
  overAllocated,
  allocations,
  onSelect,
  onDragStart,
  onAnchorClick,
}: FlowNodeProps) {
  const palette = KIND_COLOR[node.kind];
  const size = sizeOf(node, content);

  const style: CSSProperties = {
    left: node.position.x,
    top: node.position.y,
    width: size.width,
    height: size.height,
    '--node-color': palette.color,
    '--node-bg': palette.bg,
  } as CSSProperties;

  const className = [
    styles.node,
    selected ? styles.selected : '',
    connecting && !isConnectSource ? styles.connectable : '',
    isConnectSource ? styles.connectSource : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      className={className}
      style={style}
      data-node-id={node.id}
      aria-label={`${KIND_LABEL[node.kind]} ${node.name}`}
      onPointerDown={(event) => {
        onSelect();
        if (!connecting) onDragStart(event);
      }}
    >
      {/*
        In the corner, out of the flow. A holding's corner says which asset it
        is, because that is the only label it has that is not the figure below;
        a job or an account says what kind it is. Either way it costs no row —
        it sits in the node's top padding, which is why that padding is deeper
        than the bottom.
      */}
      <span
        className={styles.kind}
        title={node.kind === 'holding' ? node.asset : KIND_LABEL[node.kind]}
      >
        {node.kind === 'holding' ? node.asset : KIND_LABEL[node.kind]}
      </span>

      {/* A holding's name *is* its asset, and its asset is now in the corner.
          Repeating it would spend a row saying the same word twice. */}
      {node.kind === 'holding' ? null : (
        <span className={styles.name} title={node.name || KIND_LABEL[node.kind]}>
          {node.name || KIND_LABEL[node.kind]}
        </span>
      )}

      {node.kind === 'job' ? (
        <JobBody node={node} overAllocated={overAllocated} allocations={allocations} />
      ) : null}
      {node.kind === 'holding' ? <HoldingBody node={node} /> : null}
      {node.kind === 'account' ? (
        <AccountBody
          summary={accountSummary}
          overAllocated={overAllocated}
          allocations={allocations}
        />
      ) : null}

      {connecting
        ? ANCHORS.map((anchor) => (
            <button
              key={anchor}
              type="button"
              className={`${styles.anchor} ${keyboardAnchor === anchor ? styles.anchorKeyboard : ''}`}
              style={ANCHOR_OFFSETS[anchor]}
              title={`Connect from ${anchor}`}
              aria-label={`Connect from ${anchor}`}
              tabIndex={-1}
              aria-pressed={keyboardAnchor === anchor || undefined}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onAnchorClick(anchor);
              }}
            />
          ))
        : null}
    </article>
  );
}

/**
 * One asset that has flows leaving it, in the order it is read: which asset,
 * what is left of it, what there was, and the share still free.
 *
 * One centred row, full width. The wider 240px node reserves enough room for
 * the symbol, paired amounts, and percentage at a readable size without
 * wrapping — a wrapped row would be a line the geometry did not reserve.
 */
function Allocations({ allocations }: { allocations: NonNullable<FlowNodeProps['allocations']> }) {
  return (
    <div className={styles.allocations}>
      {allocations.map((item) => (
        <span
          key={item.asset}
          className={`${styles.allocation} ${item.exceeded ? styles.allocationOver : ''}`}
          title={
            item.exceeded
              ? `The flows leaving this ${item.asset} balance promise more than it holds.`
              : `${formatAmount(item.remaining)} free of ${formatAmount(item.total)}`
          }
        >
          <span className={styles.allocationAsset}>{item.asset}</span>
          <span className={styles.allocationAmounts}>
            <strong>{formatAmount(item.remaining)}</strong>
            <span className={styles.allocationOf}> / {formatAmount(item.total)}</span>
          </span>
          <span className={styles.allocationPct}>
            {item.exceeded ? 'OVER' : `${Math.round(item.pct)}%`}
          </span>
        </span>
      ))}
    </div>
  );
}

function JobBody({
  node,
  overAllocated,
  allocations,
}: {
  node: Extract<FinanceNode, { kind: 'job' }>;
  overAllocated?: ReadonlySet<string>;
  allocations?: FlowNodeProps['allocations'];
}) {
  const active = node.balances.filter((balance) => balance.active);
  if (!active.length) return <span className={styles.muted}>No assets yet</span>;

  // An allocated asset is shown by `Allocations`, in full, so it leaves the
  // chips rather than being said twice.
  const allocated = new Set((allocations ?? []).map((item) => item.asset));
  const chips = active.filter((balance) => !allocated.has(balance.asset));

  return (
    <>
      {allocations?.length ? <Allocations allocations={allocations} /> : null}
      {chips.length ? (
        <div className={styles.balances}>
          {chips.map((balance) => (
            <span
              key={balance.asset}
              className={`${styles.balance} ${overAllocated?.has(balance.asset) ? styles.balanceOver : ''}`}
              title={
                overAllocated?.has(balance.asset)
                  ? `The flows leaving this ${balance.asset} balance promise more than it holds.`
                  : `${balance.asset} ${formatAmount(balance.amount ?? 0)}`
              }
            >
              {balance.asset} <strong>{formatAmount(balance.amount ?? 0)}</strong>
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

function HoldingBody({ node }: { node: Extract<FinanceNode, { kind: 'holding' }> }) {
  const fees = [feeLabel(node.fees.out), feeLabel(node.fees.in)];
  const feeText = [fees[0] ? `out ${fees[0]}` : '', fees[1] ? `in ${fees[1]}` : '']
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <span className={styles.amount} title={formatAmount(node.amount ?? 0)}>
        {formatAmount(node.amount ?? 0)}
      </span>
      {feeText ? (
        <span className={styles.fees} title={feeText}>
          {feeText}
        </span>
      ) : null}
    </>
  );
}

function AccountBody({
  summary,
  overAllocated,
  allocations,
}: {
  summary?: FlowNodeProps['accountSummary'];
  overAllocated?: ReadonlySet<string>;
  allocations?: FlowNodeProps['allocations'];
}) {
  if (!summary?.remaining.length) return <span className={styles.muted}>No assets yet</span>;

  const moved = summary.incoming.count + summary.outgoing.count;
  // An allocated asset is shown in full by `Allocations`, so it leaves the
  // chips rather than being said twice.
  const allocated = new Set((allocations ?? []).map((item) => item.asset));
  const chips = summary.remaining.filter((total) => !allocated.has(total.asset));

  return (
    <>
      {allocations?.length ? <Allocations allocations={allocations} /> : null}
      <div className={styles.balances}>
        {chips.map((total) => {
          // An account's remaining is already net of what its holdings have
          // promised, so a negative *is* the over-allocation rather than a hint
          // of one. Marked rather than left as a minus sign among numbers.
          const over = total.amount < 0 || overAllocated?.has(total.asset);
          return (
            <span
              key={total.asset}
              className={`${styles.balance} ${over ? styles.balanceOver : ''}`}
              title={
                over
                  ? `The flows leaving this ${total.asset} balance promise more than it holds.`
                  : `${total.asset} ${formatAmount(total.amount)}`
              }
            >
              {total.asset} <strong>{formatAmount(total.amount)}</strong>
            </span>
          );
        })}
      </div>
      {moved > 0 ? (
        <span className={styles.operations}>
          ↓{summary.incoming.count} ↑{summary.outgoing.count}
        </span>
      ) : null}
    </>
  );
}
