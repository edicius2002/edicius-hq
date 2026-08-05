import { computeTransfer, isOverdrawnByFees } from '@/features/finance/lib/fees';
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

/** What is still sitting in jobs and holdings: the balance less what it already committed. */
export function selectAvailable(diagram: Diagram): AssetTotal[] {
  const totals = new Map<AssetCode, number>();

  for (const node of listNodes(diagram)) {
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

/** What is mid-flight: the net of every flow that still carries value after fees. */
export function selectInTransit(diagram: Diagram): AssetTotal[] {
  const totals = new Map<AssetCode, number>();

  for (const flow of listFlows(diagram)) {
    const gross = grossOf(flow);
    if (gross <= 0) continue;

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
