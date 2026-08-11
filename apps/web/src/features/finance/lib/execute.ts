import { computeTransfer, isOverdrawnByFees } from '@/features/finance/lib/fees';
import { formatAmount } from '@/shared/lib/money';
import { selectAllocation } from '@/features/finance/lib/summary';
import type { AssetCode, Diagram, FlowId, FinanceNode } from '@/features/finance/model/types';
import { err, ok, type Result } from '@/features/finance/lib/result';

/**
 * Carrying out a flow, rather than only describing one.
 *
 * Until now a flow said what *would* move; nothing moved it. The legacy could —
 * `canExecuteEdge` and `applyEdgeSettlement` in `js/flow.js` — and its refusals
 * are ported here rather than reinvented, because each one is a rule about money
 * that we would otherwise learn again the hard way.
 *
 * **An executed flow keeps its place and loses its amount.** That is the legacy's
 * answer (`edge.amount = 0`) and it is the right one for a diagram: the shape of
 * where money goes is worth keeping after a particular transfer has happened.
 * The alternative — deleting the flow — would make the drawing forget its own
 * structure every time it was used.
 */

export type ExecuteError =
  | { code: 'missing-flow' }
  | { code: 'missing-node' }
  | { code: 'no-amount' }
  | { code: 'fees-exceed-amount' }
  | { code: 'account-endpoint' }
  | { code: 'cross-asset'; from: AssetCode; to: AssetCode }
  | { code: 'insufficient'; asset: AssetCode; held: number; needed: number }
  | { code: 'over-allocated'; asset: AssetCode };

export function describeExecuteError(error: ExecuteError): string {
  switch (error.code) {
    case 'missing-flow':
      return 'That flow is gone.';
    case 'missing-node':
      return 'One end of this flow no longer exists.';
    case 'no-amount':
      return 'Set an amount above zero before executing.';
    case 'fees-exceed-amount':
      return 'The fees are bigger than the amount, so nothing would arrive.';
    case 'account-endpoint':
      return 'Execute between the assets inside the accounts, not the accounts themselves.';
    case 'cross-asset':
      return `This moves ${error.from} into ${error.to}. Converting between assets needs a rate, which nothing here has.`;
    case 'insufficient':
      // Through the app's own formatter. Written raw, these were the one place
      // a number appeared with a point while every other figure on the screen
      // used a comma — in the message that exists to be read carefully.
      return `Only ${formatAmount(error.held)} ${error.asset} available, and this moves ${formatAmount(error.needed)}.`;
    case 'over-allocated':
      return `The flows leaving this ${error.asset} balance already promise more than it holds.`;
  }
}

/** What a node holds of one asset, or null where the question does not apply. */
function heldOf(node: FinanceNode, asset: AssetCode): number | null {
  if (node.kind === 'holding') return node.asset === asset ? (node.amount ?? 0) : null;
  if (node.kind === 'job') {
    const balance = node.balances.find((item) => item.asset === asset && item.active);
    return balance ? (balance.amount ?? 0) : null;
  }
  return null;
}

/**
 * Whether this flow can be carried out, and if not, why.
 *
 * Ordered so the answer is the most useful one: what is structurally wrong
 * before what is arithmetically wrong, and the flow's own problems before the
 * balance's. A caller that only wants a boolean can read `.ok`.
 */
export function canExecuteFlow(diagram: Diagram, id: FlowId): Result<null, ExecuteError> {
  const flow = diagram.flows[id];
  if (!flow) return err({ code: 'missing-flow' });

  const source = diagram.nodes[flow.from];
  const target = diagram.nodes[flow.to];
  if (!source || !target) return err({ code: 'missing-node' });

  // An account is never an endpoint of a flow, so this should be unreachable
  // through `connect`. Checked anyway: a restored document is not ours to trust.
  if (source.kind === 'account' || target.kind === 'account') {
    return err({ code: 'account-endpoint' });
  }

  const gross = flow.amount ?? 0;
  if (!(gross > 0)) return err({ code: 'no-amount' });

  // Both ends must speak the same asset. The legacy refused to convert rather
  // than inventing a rate, and nothing here has one either.
  if (target.kind === 'holding' && target.asset !== flow.asset) {
    return err({ code: 'cross-asset', from: flow.asset, to: target.asset });
  }
  if (source.kind === 'holding' && source.asset !== flow.asset) {
    return err({ code: 'cross-asset', from: source.asset, to: flow.asset });
  }

  if (isOverdrawnByFees(computeTransfer(gross, source, target))) {
    return err({ code: 'fees-exceed-amount' });
  }

  const held = heldOf(source, flow.asset);
  if (held === null || held < gross) {
    return err({ code: 'insufficient', asset: flow.asset, held: held ?? 0, needed: gross });
  }

  // Not the same test as the one above: this flow can fit while the source's
  // flows *together* promise more than it holds, and executing one of them
  // would quietly decide which sibling goes unpaid.
  const allocation = selectAllocation(diagram, source.id, flow.asset);
  if (allocation?.exceeded) return err({ code: 'over-allocated', asset: flow.asset });

  return ok(null);
}

function creditedTo(node: FinanceNode, asset: AssetCode, amount: number): FinanceNode {
  if (node.kind === 'holding') return { ...node, amount: (node.amount ?? 0) + amount };
  if (node.kind === 'job') {
    return {
      ...node,
      balances: node.balances.map((item) =>
        item.asset === asset ? { ...item, amount: (item.amount ?? 0) + amount } : item,
      ),
    };
  }
  return node;
}

/**
 * Move the money. The source loses the gross, the target gains the net, and the
 * flow keeps its place with nothing pending on it.
 *
 * Refuses by returning the diagram untouched, so a caller that skipped
 * `canExecuteFlow` cannot half-apply a transfer. The reason is available from
 * that function; this one is the mutation.
 */
export function executeFlow(diagram: Diagram, id: FlowId): Diagram {
  if (!canExecuteFlow(diagram, id).ok) return diagram;

  const flow = diagram.flows[id];
  const source = diagram.nodes[flow.from];
  const target = diagram.nodes[flow.to];
  const gross = flow.amount ?? 0;
  const { net } = computeTransfer(gross, source, target);

  return {
    ...diagram,
    nodes: {
      ...diagram.nodes,
      [source.id]: creditedTo(source, flow.asset, -gross),
      // Written after the source, so a flow whose two ends are the same node
      // would land on the credit rather than on the debit. `connect` refuses
      // that shape; this is what happens if a restored document carries one.
      [target.id]: creditedTo(
        source.id === target.id ? creditedTo(source, flow.asset, -gross) : target,
        flow.asset,
        net,
      ),
    },
    flows: { ...diagram.flows, [id]: { ...flow, amount: null } },
  };
}
