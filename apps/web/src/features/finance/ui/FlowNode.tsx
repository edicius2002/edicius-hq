import { type CSSProperties, type PointerEvent } from 'react';

import { NODE_SIZE } from '@/features/finance/lib/geometry';
import { formatAmount } from '@/features/finance/lib/format';
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
  /** What an account is worth and how much has crossed it. */
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
  accountSummary,
  onSelect,
  onDragStart,
  onAnchorClick,
}: FlowNodeProps) {
  const palette = KIND_COLOR[node.kind];
  const size = NODE_SIZE[node.kind];

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
      <span className={styles.kind}>{KIND_LABEL[node.kind]}</span>
      <span className={styles.name}>{node.name || KIND_LABEL[node.kind]}</span>

      {node.kind === 'job' ? <JobBody node={node} /> : null}
      {node.kind === 'holding' ? <HoldingBody node={node} /> : null}
      {node.kind === 'account' ? <AccountBody summary={accountSummary} /> : null}

      {connecting
        ? ANCHORS.map((anchor) => (
            <button
              key={anchor}
              type="button"
              className={styles.anchor}
              style={ANCHOR_OFFSETS[anchor]}
              title={`Connect from ${anchor}`}
              aria-label={`Connect from ${anchor}`}
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

function JobBody({ node }: { node: Extract<FinanceNode, { kind: 'job' }> }) {
  const active = node.balances.filter((balance) => balance.active);
  if (!active.length) return <span className={styles.muted}>No assets yet</span>;

  return (
    <div className={styles.balances}>
      {active.map((balance) => (
        <span key={balance.asset} className={styles.balance}>
          {balance.asset} <strong>{formatAmount(balance.amount ?? 0)}</strong>
        </span>
      ))}
    </div>
  );
}

function HoldingBody({ node }: { node: Extract<FinanceNode, { kind: 'holding' }> }) {
  const fees = [feeLabel(node.fees.out), feeLabel(node.fees.in)];
  const feeText = [fees[0] ? `out ${fees[0]}` : '', fees[1] ? `in ${fees[1]}` : '']
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <span className={styles.amount}>{formatAmount(node.amount ?? 0)}</span>
      {feeText ? <span className={styles.fees}>{feeText}</span> : null}
    </>
  );
}

function AccountBody({ summary }: { summary?: FlowNodeProps['accountSummary'] }) {
  if (!summary?.remaining.length) return <span className={styles.muted}>No assets yet</span>;

  const moved = summary.incoming.count + summary.outgoing.count;

  return (
    <>
      <div className={styles.balances}>
        {summary.remaining.map((total) => (
          <span key={total.asset} className={styles.balance}>
            {total.asset} <strong>{formatAmount(total.amount)}</strong>
          </span>
        ))}
      </div>
      {moved > 0 ? (
        <span className={styles.operations}>
          ↓{summary.incoming.count} ↑{summary.outgoing.count}
        </span>
      ) : null}
    </>
  );
}
