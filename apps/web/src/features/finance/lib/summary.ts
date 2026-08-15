import { computeTransfer, isOverdrawnByFees } from '@/features/finance/lib/fees';
import {
  boxWidth,
  CHIP_COLUMN_GAP,
  CHIPS_PER_LINE,
  HOLDING_CONTENT_WIDTH,
  NODE_FONT,
  textWidth,
  type NodeContent,
} from '@/features/finance/lib/geometry';
import type {
  AssetCode,
  Diagram,
  FinanceNode,
  Flow,
  HoldingNode,
  NodeId,
} from '@/features/finance/model/types';

export type AssetTotal = { asset: AssetCode; amount: number };

/** How many flows crossed a boundary, and how much they carried per asset. */
export type OperationSide = { count: number; totals: AssetTotal[] };

export type AccountSummary = {
  /** Active holdings, each less what its outgoing flows already committed. */
  remaining: AssetTotal[];
  incoming: OperationSide;
  outgoing: OperationSide;
};

function listNodes(diagram: Diagram): FinanceNode[] {
  return diagram.nodeOrder.map((id) => diagram.nodes[id]).filter(Boolean);
}

function listFlows(diagram: Diagram): Flow[] {
  return diagram.flowOrder.map((id) => diagram.flows[id]).filter(Boolean);
}

function grossOf(flow: Flow): number {
  return Number.isFinite(flow.amount) && flow.amount !== null ? flow.amount : 0;
}

function addTotal(totals: Map<AssetCode, number>, asset: AssetCode, amount: number): void {
  totals.set(asset, (totals.get(asset) ?? 0) + amount);
}

/** Assets never mix, so totals stay one entry per asset, ordered by code. */
function toAssetTotals(totals: Map<AssetCode, number>, keepZero = false): AssetTotal[] {
  return [...totals.entries()]
    .filter(([, amount]) => keepZero || amount > 0)
    .map(([asset, amount]) => ({ asset, amount }))
    .sort((a, b) => a.asset.localeCompare(b.asset));
}

function outgoingOf(diagram: Diagram, nodeId: NodeId, asset?: AssetCode): Flow[] {
  return listFlows(diagram).filter(
    (flow) => flow.from === nodeId && (asset === undefined || flow.asset === asset),
  );
}

function committed(diagram: Diagram, nodeId: NodeId, asset?: AssetCode): number {
  return outgoingOf(diagram, nodeId, asset).reduce((sum, flow) => sum + grossOf(flow), 0);
}

export function selectHoldingsOfAccount(diagram: Diagram, accountId: NodeId): HoldingNode[] {
  return listNodes(diagram).filter(
    (node): node is HoldingNode => node.kind === 'holding' && node.accountId === accountId,
  );
}

/**
 * A source may not send more than it holds. When it does, the legacy drops all of
 * that source's flows from the in-transit total rather than letting them inflate
 * it, and this keeps that rule.
 */
function isOverAllocated(diagram: Diagram, source: FinanceNode, asset: AssetCode): boolean {
  if (source.kind === 'job') {
    const balance = source.balances.find((item) => item.asset === asset && item.active);
    const held = balance?.amount ?? 0;
    if (held <= 0) return true;
    return committed(diagram, source.id, asset) > held;
  }

  if (source.kind === 'holding') {
    return committed(diagram, source.id) > (source.amount ?? 0);
  }

  return false;
}

/**
 * What a set of nodes still holds: the balance less what it already committed.
 * Taking the set as an argument is what lets a frame report its own total
 * through the very same arithmetic the headline uses, so the two can never
 * disagree about the same money.
 */
function availableOf(diagram: Diagram, nodes: FinanceNode[]): AssetTotal[] {
  const totals = new Map<AssetCode, number>();

  for (const node of nodes) {
    if (node.kind === 'job') {
      for (const balance of node.balances) {
        if (!balance.active) continue;
        const held = balance.amount ?? 0;
        if (held <= 0) continue;
        addTotal(totals, balance.asset, held - committed(diagram, node.id, balance.asset));
      }
      continue;
    }

    if (node.kind === 'holding' && node.active) {
      const held = node.amount ?? 0;
      if (held <= 0) continue;
      addTotal(totals, node.asset, held - committed(diagram, node.id));
    }
  }

  return toAssetTotals(totals);
}

/** Everything still sitting in jobs and holdings across the whole diagram. */
export function selectAvailable(diagram: Diagram): AssetTotal[] {
  return availableOf(diagram, listNodes(diagram));
}

export type FrameSummary = { nodeCount: number; totals: AssetTotal[] };

/**
 * What a frame is worth. An account contributes nothing of its own — it holds no
 * money, its holdings do — so a frame drawn around an account whose holdings sit
 * outside it reports nothing, which is the honest answer.
 */
export function selectFrameSummary(diagram: Diagram, members: FinanceNode[]): FrameSummary {
  return { nodeCount: members.length, totals: availableOf(diagram, members) };
}

/** A switched-off holding is out of play, so nothing can move to or from it. */
function isDormant(node: FinanceNode | undefined): boolean {
  return node?.kind === 'holding' && !node.active;
}

/** Whether a flow is live: both ends present and switched on. */
export function isFlowActive(diagram: Diagram, flow: Flow): boolean {
  const source = diagram.nodes[flow.from];
  const target = diagram.nodes[flow.to];
  return Boolean(source) && Boolean(target) && !isDormant(source) && !isDormant(target);
}

/** What is mid-flight: the net of every flow that still carries value after fees. */
export function selectInTransit(diagram: Diagram): AssetTotal[] {
  const totals = new Map<AssetCode, number>();

  for (const flow of listFlows(diagram)) {
    const gross = grossOf(flow);
    if (gross <= 0) continue;
    if (!isFlowActive(diagram, flow)) continue;

    const source = diagram.nodes[flow.from];
    const target = diagram.nodes[flow.to];
    if (!source || !target) continue;
    if (isOverAllocated(diagram, source, flow.asset)) continue;

    const breakdown = computeTransfer(gross, source, target);
    if (isOverdrawnByFees(breakdown) || breakdown.net <= 0) continue;

    addTotal(totals, flow.asset, breakdown.net);
  }

  return toAssetTotals(totals);
}

/**
 * What an account is worth and how much has moved through it. Accounts hold no
 * money themselves — everything here comes from the holdings they own.
 *
 * Outgoing counts the gross that left a holding; incoming counts the net that
 * actually arrived, since fees are taken in flight.
 */
export function selectAccountSummary(diagram: Diagram, accountId: NodeId): AccountSummary {
  const holdings = selectHoldingsOfAccount(diagram, accountId).filter((holding) => holding.active);
  const holdingIds = new Set(holdings.map((holding) => holding.id));

  const remaining = new Map<AssetCode, number>();
  for (const holding of holdings) {
    addTotal(remaining, holding.asset, (holding.amount ?? 0) - committed(diagram, holding.id));
  }

  const incomingTotals = new Map<AssetCode, number>();
  const outgoingTotals = new Map<AssetCode, number>();
  let incomingCount = 0;
  let outgoingCount = 0;

  for (const flow of listFlows(diagram)) {
    const gross = grossOf(flow);
    if (gross <= 0) continue;

    if (holdingIds.has(flow.from)) {
      outgoingCount += 1;
      addTotal(outgoingTotals, flow.asset, gross);
    }

    if (holdingIds.has(flow.to)) {
      const breakdown = computeTransfer(gross, diagram.nodes[flow.from], diagram.nodes[flow.to]);
      if (!isOverdrawnByFees(breakdown)) {
        incomingCount += 1;
        addTotal(incomingTotals, flow.asset, breakdown.net);
      }
    }
  }

  return {
    // An empty holding is still worth showing on its own account.
    remaining: toAssetTotals(remaining, true),
    incoming: { count: incomingCount, totals: toAssetTotals(incomingTotals) },
    outgoing: { count: outgoingCount, totals: toAssetTotals(outgoingTotals) },
  };
}

/**
 * How much of one balance is already promised, and how much is still free.
 *
 * A node has always shown what is left; nothing showed what is committed, so a
 * balance of 1.000 with 900 already allocated read exactly like one with nothing
 * allocated. The legacy drew this on the node — `accountCurrencyBalanceMeta` in
 * `js/flow.js` — and the arithmetic here is the same one, reusing `committed`
 * so a percentage can never disagree with the totals computed from it.
 *
 * `exceeded` is the case worth having: a diagram that does not add up. It is
 * reported rather than clamped, because `remaining` going negative is the fact,
 * and `pct` is clamped only because a bar cannot be more than full.
 */
export type Allocation = {
  /** What the balance holds before anything leaves it. */
  total: number;
  /** The gross of every outgoing flow of this asset. */
  committed: number;
  /** `total - committed`. Negative when the flows promise more than exists. */
  remaining: number;
  /** Share of the balance still free, 0–100. Zero when there is nothing to divide. */
  pct: number;
  exceeded: boolean;
};

export function selectAllocation(
  diagram: Diagram,
  nodeId: NodeId,
  asset: AssetCode,
): Allocation | null {
  const node = diagram.nodes[nodeId];
  if (!node) return null;

  let total: number;
  if (node.kind === 'holding') {
    if (node.asset !== asset) return null;
    total = node.amount ?? 0;
  } else if (node.kind === 'job') {
    const balance = node.balances.find((item) => item.asset === asset && item.active);
    if (!balance) return null;
    total = balance.amount ?? 0;
  } else {
    // An account holds nothing itself; ask its holdings.
    return null;
  }

  const out = committed(diagram, nodeId, asset);
  const remaining = total - out;
  return {
    total,
    committed: out,
    remaining,
    pct: total > 0 ? Math.max(0, Math.min((remaining / total) * 100, 100)) : 0,
    exceeded: out > total,
  };
}

/** One asset of a node, with how much of it is still free. */
export type AssetAllocation = Allocation & { asset: AssetCode };

/**
 * Every asset a node shows, and what each has left against what it had.
 *
 * A job answers for itself; an account answers for the holdings it owns, which
 * is why an asset held twice in one account is summed rather than listed twice —
 * the node shows one line per asset, so the arithmetic has to agree with that.
 *
 * Only assets with something actually promised come back. An asset with no
 * outgoing flows has nothing to say beyond its balance, which the node already
 * shows.
 */
export function selectAssetAllocations(diagram: Diagram, node: FinanceNode): AssetAllocation[] {
  if (node.kind === 'job') {
    return node.balances
      .filter((balance) => balance.active)
      .flatMap((balance) => {
        const allocation = selectAllocation(diagram, node.id, balance.asset);
        return allocation && allocation.committed > 0
          ? [{ asset: balance.asset, ...allocation }]
          : [];
      });
  }

  if (node.kind !== 'account') return [];

  const totals = new Map<AssetCode, { total: number; committed: number }>();
  for (const holding of selectHoldingsOfAccount(diagram, node.id)) {
    if (!holding.active) continue;
    const entry = totals.get(holding.asset) ?? { total: 0, committed: 0 };
    entry.total += holding.amount ?? 0;
    entry.committed += committed(diagram, holding.id);
    totals.set(holding.asset, entry);
  }

  return [...totals.entries()]
    .filter(([, entry]) => entry.committed > 0)
    .map(([asset, entry]) => {
      const remaining = entry.total - entry.committed;
      return {
        asset,
        total: entry.total,
        committed: entry.committed,
        remaining,
        pct: entry.total > 0 ? Math.max(0, Math.min((remaining / entry.total) * 100, 100)) : 0,
        exceeded: entry.committed > entry.total,
      };
    });
}

/**
 * How many rows a node will show, from the document alone.
 *
 * This is what lets `sizeOf` follow the content without a layout pass: every
 * question a box's height depends on — does this holding carry a fee, how many
 * assets does this account still hold, has it seen any traffic — is answerable
 * here, from the same data the money maths already reads.
 *
 * Every consumer of a node's rectangle has to route through this. A frame that
 * measured a node differently from the canvas would decide ownership on a box
 * nobody could see.
 */
export function selectNodeContent(diagram: Diagram, node: FinanceNode): NodeContent {
  if (node.kind === 'holding') {
    const fees = node.fees;
    const charged = (fee: { value: number } | null) => Boolean(fee && fee.value !== 0);
    return { extraRow: charged(fees.out) || charged(fees.in) };
  }

  const allocated = selectAssetAllocations(diagram, node);

  if (node.kind === 'job') {
    const chips = node.balances
      .filter(
        (balance) => balance.active && !allocated.some((item) => item.asset === balance.asset),
      )
      .map((balance) => balance.asset);
    // An allocated asset is drawn as its own two-line block, so it leaves the
    // chips rather than wrapping among them.
    return {
      assetRows: chips.length,
      allocatedRows: allocated.length,
      // A job holds no holdings, so its own rows are the whole of its width.
      minimumWidth: intrinsicWidth(node.name || 'Job', chips, allocated),
    };
  }

  const summary = selectAccountSummary(diagram, node.id);
  const chips = summary.remaining
    .filter((total) => !allocated.some((item) => item.asset === total.asset))
    .map((total) => total.asset);
  return {
    assetRows: chips.length,
    allocatedRows: allocated.length,
    extraRow: summary.incoming.count + summary.outgoing.count > 0,
    // An account is never narrower than a holding it owns: the two are read as
    // one stack, and a parent thinner than its child reads as a mistake. Where
    // those holdings happen to sit is not part of it — an account says what it
    // holds, and two accounts saying the same thing are the same width however
    // far apart their holdings have been dragged.
    minimumWidth: Math.max(
      HOLDING_CONTENT_WIDTH,
      intrinsicWidth(node.name || 'Account', chips, allocated),
    ),
  };
}

/**
 * The longest figure a chip or an allocation promises to fit, as digits.
 *
 * The same worst case the holding box is sized for, and worst case on purpose:
 * a width taken from the amount currently typed would make the box twitch on
 * every keystroke. It settles once, at the widest number Finance promises.
 */
const WORST_AMOUNT = '9'.repeat('99,999.99'.length);

/**
 * The narrowest a job or an account can be drawn without clipping what it says.
 *
 * Every block inside the box is measured, and the widest one wins — the name,
 * the chip columns, and the allocation lines are all full-width children of the
 * same grid, so the box has to hold the largest of them and no more.
 *
 * Conservative text metrics, no DOM: this runs for every node on every render
 * of the canvas, and a layout pass here is exactly what `geometry.ts` exists to
 * avoid. `sizeOf` clamps the result to the kind's bound, so the caller cannot
 * widen a node past what the diagram reserves for it.
 */
function intrinsicWidth(
  name: string,
  chips: readonly AssetCode[],
  allocated: readonly AssetAllocation[],
): number {
  const nameWidth = textWidth(name.length, NODE_FONT.name);

  // Chips sit two to a line in a fixed two-column grid, so two of them need
  // both columns *and* the gap between. Measuring one and drawing two is what
  // left a two-asset account 124px wide with both its amounts ellipsised.
  const columns = Math.min(chips.length, CHIPS_PER_LINE);
  const widestChip = chips.length
    ? Math.max(
        ...chips.map((asset) => textWidth(`${asset} ${WORST_AMOUNT}`.length, NODE_FONT.balance)),
      )
    : 0;
  const chipsWidth = widestChip * columns + CHIP_COLUMN_GAP * Math.max(0, columns - 1);

  // One line, full width: symbol, remaining over total, and the share still free.
  const allocationWidth = allocated.length
    ? Math.max(
        ...allocated.map((item) =>
          textWidth(
            `${item.asset} ${WORST_AMOUNT} / ${WORST_AMOUNT} 100%`.length,
            NODE_FONT.allocation,
          ),
        ),
      )
    : 0;

  // Nothing to show is still a line: "No assets yet".
  const emptyWidth =
    chips.length || allocated.length ? 0 : textWidth('No assets yet'.length, NODE_FONT.muted);

  return boxWidth(Math.max(nameWidth, chipsWidth, allocationWidth, emptyWidth));
}
