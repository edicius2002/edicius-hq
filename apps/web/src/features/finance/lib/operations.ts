import { DEFAULT_ASSET } from '@/features/finance/lib/document';
import { frameMembers, FRAME_MIN_SIZE } from '@/features/finance/lib/frames';
import { err, ok, type Result } from '@/features/finance/lib/result';
import type {
  Anchor,
  AssetCode,
  Diagram,
  FinanceNode,
  Flow,
  FlowId,
  Frame,
  FrameId,
  HoldingNode,
  JobNode,
  NodeId,
  Point,
  Size,
} from '@/features/finance/model/types';

// Every function here is a pure transition: it takes a diagram and returns a new
// one, never mutating the input. Ids arrive from the caller rather than being
// generated, which keeps these deterministic and testable. See ADR 0001.

const NO_FEES = { in: null, out: null } as const;

function normalizeAsset(asset: string): AssetCode {
  return asset.trim().toUpperCase();
}

function withNode(diagram: Diagram, node: FinanceNode): Diagram {
  const isNew = !diagram.nodes[node.id];
  return {
    ...diagram,
    nodes: { ...diagram.nodes, [node.id]: node },
    nodeOrder: isNew ? [...diagram.nodeOrder, node.id] : diagram.nodeOrder,
  };
}

function withFlow(diagram: Diagram, flow: Flow): Diagram {
  const isNew = !diagram.flows[flow.id];
  return {
    ...diagram,
    flows: { ...diagram.flows, [flow.id]: flow },
    flowOrder: isNew ? [...diagram.flowOrder, flow.id] : diagram.flowOrder,
  };
}

/** Edit one node in place, leaving the diagram untouched if it is not there. */
function mapNode(diagram: Diagram, id: NodeId, edit: (node: FinanceNode) => FinanceNode): Diagram {
  const node = diagram.nodes[id];
  return node ? withNode(diagram, edit(node)) : diagram;
}

function mapJob(diagram: Diagram, id: NodeId, edit: (job: JobNode) => JobNode): Diagram {
  return mapNode(diagram, id, (node) => (node.kind === 'job' ? edit(node) : node));
}

function mapHolding(
  diagram: Diagram,
  id: NodeId,
  edit: (holding: HoldingNode) => HoldingNode,
): Diagram {
  return mapNode(diagram, id, (node) => (node.kind === 'holding' ? edit(node) : node));
}

// --- nodes ---------------------------------------------------------------

export function addJob(
  diagram: Diagram,
  input: { id: NodeId; position: Point; name?: string },
): Diagram {
  return withNode(diagram, {
    id: input.id,
    kind: 'job',
    name: input.name ?? 'Job',
    notes: '',
    position: input.position,
    balances: [],
  });
}

export function addAccount(
  diagram: Diagram,
  input: { id: NodeId; position: Point; name?: string },
): Diagram {
  return withNode(diagram, {
    id: input.id,
    kind: 'account',
    name: input.name ?? 'Account',
    notes: '',
    position: input.position,
  });
}

export type AddHoldingError =
  { code: 'account-missing' } | { code: 'asset-already-held'; asset: AssetCode };

/**
 * Add an asset to an account. An account holds each asset once, so re-adding one
 * that is merely switched off reactivates it and keeps whatever amount it had.
 */
export function addHolding(
  diagram: Diagram,
  input: { id: NodeId; accountId: NodeId; asset: string; position: Point },
): Result<Diagram, AddHoldingError> {
  const account = diagram.nodes[input.accountId];
  if (account?.kind !== 'account') return err({ code: 'account-missing' });

  const asset = normalizeAsset(input.asset) || DEFAULT_ASSET;
  const existing = Object.values(diagram.nodes).find(
    (node): node is HoldingNode =>
      node.kind === 'holding' && node.accountId === input.accountId && node.asset === asset,
  );

  if (existing) {
    if (existing.active) return err({ code: 'asset-already-held', asset });
    return ok(mapHolding(diagram, existing.id, (holding) => ({ ...holding, active: true })));
  }

  return ok(
    withNode(diagram, {
      id: input.id,
      kind: 'holding',
      name: asset,
      notes: '',
      position: input.position,
      accountId: input.accountId,
      asset,
      amount: null,
      fees: { ...NO_FEES },
      active: true,
    }),
  );
}

export function moveNode(diagram: Diagram, id: NodeId, position: Point): Diagram {
  return mapNode(diagram, id, (node) => ({ ...node, position }));
}

export function renameNode(diagram: Diagram, id: NodeId, name: string): Diagram {
  return mapNode(diagram, id, (node) => ({ ...node, name }));
}

export function setNotes(diagram: Diagram, id: NodeId, notes: string): Diagram {
  return mapNode(diagram, id, (node) => ({ ...node, notes }));
}

export function updateHolding(
  diagram: Diagram,
  id: NodeId,
  patch: Partial<Pick<HoldingNode, 'amount' | 'fees' | 'active'>>,
): Diagram {
  return mapHolding(diagram, id, (holding) => ({ ...holding, ...patch }));
}

/** Switching a holding off keeps its amount, so switching it back on restores it. */
export function setHoldingActive(diagram: Diagram, id: NodeId, active: boolean): Diagram {
  return updateHolding(diagram, id, { active });
}

// --- job balances --------------------------------------------------------

export function addJobAsset(diagram: Diagram, jobId: NodeId, rawAsset: string): Diagram {
  const asset = normalizeAsset(rawAsset);
  if (!asset) return diagram;

  return mapJob(diagram, jobId, (job) => {
    const existing = job.balances.find((balance) => balance.asset === asset);
    if (existing) {
      return {
        ...job,
        balances: job.balances.map((balance) =>
          balance.asset === asset ? { ...balance, active: true } : balance,
        ),
      };
    }
    return { ...job, balances: [...job.balances, { asset, amount: null, active: true }] };
  });
}

export function setJobBalance(
  diagram: Diagram,
  jobId: NodeId,
  asset: AssetCode,
  amount: number | null,
): Diagram {
  return mapJob(diagram, jobId, (job) => ({
    ...job,
    balances: job.balances.map((balance) =>
      balance.asset === asset ? { ...balance, amount } : balance,
    ),
  }));
}

export function setJobAssetActive(
  diagram: Diagram,
  jobId: NodeId,
  asset: AssetCode,
  active: boolean,
): Diagram {
  return mapJob(diagram, jobId, (job) => ({
    ...job,
    balances: job.balances.map((balance) =>
      balance.asset === asset ? { ...balance, active } : balance,
    ),
  }));
}

// --- deletion ------------------------------------------------------------

function removeNodes(diagram: Diagram, ids: Set<NodeId>): Diagram {
  const nodes = Object.fromEntries(Object.entries(diagram.nodes).filter(([id]) => !ids.has(id)));
  const flows = Object.fromEntries(
    Object.entries(diagram.flows).filter(([, flow]) => !ids.has(flow.from) && !ids.has(flow.to)),
  );
  return {
    ...diagram,
    nodes,
    nodeOrder: diagram.nodeOrder.filter((id) => !ids.has(id)),
    flows,
    flowOrder: diagram.flowOrder.filter((id) => Boolean(flows[id])),
  };
}

/**
 * Deleting an account takes its holdings with it, since a holding cannot exist
 * without an owner. Flows touching anything removed go too.
 */
export function deleteNode(diagram: Diagram, id: NodeId): Diagram {
  const node = diagram.nodes[id];
  if (!node) return diagram;

  const doomed = new Set<NodeId>([id]);
  if (node.kind === 'account') {
    for (const candidate of Object.values(diagram.nodes)) {
      if (candidate.kind === 'holding' && candidate.accountId === id) doomed.add(candidate.id);
    }
  }

  return removeNodes(diagram, doomed);
}

// --- frames --------------------------------------------------------------

function withFrame(diagram: Diagram, frame: Frame): Diagram {
  const isNew = !diagram.frames[frame.id];
  return {
    ...diagram,
    frames: { ...diagram.frames, [frame.id]: frame },
    frameOrder: isNew ? [...diagram.frameOrder, frame.id] : diagram.frameOrder,
  };
}

function atLeastMinimum(size: Size): Size {
  return {
    width: Math.max(FRAME_MIN_SIZE.width, Math.round(size.width)),
    height: Math.max(FRAME_MIN_SIZE.height, Math.round(size.height)),
  };
}

export function addFrame(
  diagram: Diagram,
  input: { id: FrameId; position: Point; size: Size; name?: string },
): Diagram {
  return withFrame(diagram, {
    id: input.id,
    name: input.name ?? `Frame ${diagram.frameOrder.length + 1}`,
    position: input.position,
    size: atLeastMinimum(input.size),
  });
}

export function renameFrame(diagram: Diagram, id: FrameId, name: string): Diagram {
  const frame = diagram.frames[id];
  return frame ? withFrame(diagram, { ...frame, name }) : diagram;
}

/**
 * Move a frame, carrying what it holds.
 *
 * Members are read from the geometry before the move rather than after, so a
 * frame sliding across a stationary node picks it up on arrival instead of
 * shoving it along for the rest of the gesture. Because the members travel with
 * the frame they stay inside it, which is what keeps membership from flickering
 * mid-drag even though it is recomputed on every step.
 */
export function moveFrame(diagram: Diagram, id: FrameId, position: Point): Diagram {
  const frame = diagram.frames[id];
  if (!frame) return diagram;

  const delta = { x: position.x - frame.position.x, y: position.y - frame.position.y };
  if (delta.x === 0 && delta.y === 0) return diagram;

  const nodes = { ...diagram.nodes };
  for (const member of frameMembers(diagram, id)) {
    nodes[member.id] = {
      ...member,
      position: { x: member.position.x + delta.x, y: member.position.y + delta.y },
    };
  }

  return withFrame({ ...diagram, nodes }, { ...frame, position });
}

/** Resizing only changes the rectangle. What it now holds follows on its own. */
export function resizeFrame(diagram: Diagram, id: FrameId, position: Point, size: Size): Diagram {
  const frame = diagram.frames[id];
  if (!frame) return diagram;
  return withFrame(diagram, { ...frame, position, size: atLeastMinimum(size) });
}

/** A frame holds nothing of its own, so removing one leaves every node in place. */
export function deleteFrame(diagram: Diagram, id: FrameId): Diagram {
  if (!diagram.frames[id]) return diagram;

  const frames = { ...diagram.frames };
  delete frames[id];
  return { ...diagram, frames, frameOrder: diagram.frameOrder.filter((item) => item !== id) };
}

// --- flows ---------------------------------------------------------------

export type ConnectError =
  | { code: 'same-node' }
  | { code: 'missing-node' }
  | { code: 'already-connected' }
  | { code: 'job-target' }
  | { code: 'account-endpoint' }
  | { code: 'same-account' }
  | { code: 'asset-not-on-job'; asset: AssetCode };

export function describeConnectError(error: ConnectError): string {
  switch (error.code) {
    case 'same-node':
      return 'A flow needs two different nodes.';
    case 'missing-node':
      return 'One end of this flow no longer exists.';
    case 'already-connected':
      return 'These two are already connected.';
    case 'job-target':
      return 'Jobs are where money starts, so they take no incoming flows.';
    case 'account-endpoint':
      return 'Connect the assets inside the accounts, not the accounts themselves.';
    case 'same-account':
      return 'Both assets belong to the same account, so nothing would move.';
    case 'asset-not-on-job':
      return `Add ${error.asset} to the job before sending it.`;
  }
}

/** Which asset a flow carries, taken from whichever end pins it down. */
function assetForFlow(source: FinanceNode, target: FinanceNode): AssetCode {
  if (target.kind === 'holding') return target.asset;
  if (source.kind === 'holding') return source.asset;
  return DEFAULT_ASSET;
}

export function connect(
  diagram: Diagram,
  input: {
    id: FlowId;
    from: NodeId;
    to: NodeId;
    fromAnchor?: Anchor;
    toAnchor?: Anchor;
    amount?: number | null;
  },
): Result<Diagram, ConnectError> {
  if (input.from === input.to) return err({ code: 'same-node' });

  const source = diagram.nodes[input.from];
  const target = diagram.nodes[input.to];
  if (!source || !target) return err({ code: 'missing-node' });

  const connected = Object.values(diagram.flows).some(
    (flow) =>
      (flow.from === input.from && flow.to === input.to) ||
      (flow.from === input.to && flow.to === input.from),
  );
  if (connected) return err({ code: 'already-connected' });

  if (target.kind === 'job') return err({ code: 'job-target' });
  // An account is a container; money sits in its holdings, so it is never an end.
  if (source.kind === 'account' || target.kind === 'account') {
    return err({ code: 'account-endpoint' });
  }

  if (source.kind === 'holding' && target.kind === 'holding') {
    if (source.accountId === target.accountId) return err({ code: 'same-account' });
  }

  if (source.kind === 'job' && target.kind === 'holding') {
    const held = source.balances.some(
      (balance) => balance.asset === target.asset && balance.active,
    );
    if (!held) return err({ code: 'asset-not-on-job', asset: target.asset });
  }

  return ok(
    withFlow(diagram, {
      id: input.id,
      from: input.from,
      to: input.to,
      fromAnchor: input.fromAnchor ?? 'r',
      toAnchor: input.toAnchor ?? 'l',
      amount: input.amount ?? null,
      asset: assetForFlow(source, target),
      label: '',
      notes: '',
      labelOffset: null,
    }),
  );
}

export function updateFlow(
  diagram: Diagram,
  id: FlowId,
  patch: Partial<
    Pick<Flow, 'amount' | 'label' | 'notes' | 'labelOffset' | 'fromAnchor' | 'toAnchor'>
  >,
): Diagram {
  const flow = diagram.flows[id];
  return flow ? withFlow(diagram, { ...flow, ...patch }) : diagram;
}

export function deleteFlow(diagram: Diagram, id: FlowId): Diagram {
  if (!diagram.flows[id]) return diagram;
  const flows = Object.fromEntries(Object.entries(diagram.flows).filter(([key]) => key !== id));
  return { ...diagram, flows, flowOrder: diagram.flowOrder.filter((key) => key !== id) };
}
