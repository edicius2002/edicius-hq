export type NodeId = string;
export type FlowId = string;
export type DiagramId = string;

/** An ISO 4217 code, a crypto ticker, or a stock symbol — whatever a holding stores. */
export type AssetCode = string;

export type Point = { x: number; y: number };

export type Size = { width: number; height: number };

/** A region of the canvas: where it starts and how far it runs. */
export type Rect = { left: number; top: number; width: number; height: number };

export type FeeType = 'percent' | 'fixed';

export type Fee = { value: number; type: FeeType };

/** Charged on the way out of a node and on the way into one; either side may be unset. */
export type FeePolicy = { in: Fee | null; out: Fee | null };

/**
 * One asset a job is paid in. An inactive balance keeps its amount, so switching
 * an asset back on restores what was there instead of starting from blank.
 */
export type Balance = { asset: AssetCode; amount: number | null; active: boolean };

type NodeBase = {
  id: NodeId;
  name: string;
  notes: string;
  position: Point;
};

/** Where money comes from. Paid in one or more assets. */
export type JobNode = NodeBase & {
  kind: 'job';
  balances: Balance[];
};

/**
 * Owns holdings. It carries no fees of its own: an account is never an endpoint
 * of a flow, so it can never charge one. What it shows is derived from the
 * holdings it owns — see the account selectors.
 */
export type AccountNode = NodeBase & {
  kind: 'account';
};

/** A balance of one asset inside an account. */
export type HoldingNode = NodeBase & {
  kind: 'holding';
  /** Ownership is a field, not an edge — see ADR 0001. */
  accountId: NodeId;
  asset: AssetCode;
  amount: number | null;
  fees: FeePolicy;
  /** Inactive holdings leave the canvas but keep their amount. */
  active: boolean;
};

export type FinanceNode = JobNode | AccountNode | HoldingNode;

export type NodeKind = FinanceNode['kind'];

export type Anchor = 'tl' | 't' | 'tr' | 'r' | 'br' | 'b' | 'bl' | 'l';

/** A movement of money. Every flow is real; there are no structural edges. */
export type Flow = {
  id: FlowId;
  from: NodeId;
  to: NodeId;
  fromAnchor: Anchor;
  toAnchor: Anchor;
  amount: number | null;
  asset: AssetCode;
  label: string;
  notes: string;
  /** Manual nudge for the label, relative to the midpoint of the flow. */
  labelOffset: Point | null;
};

/**
 * Nodes and flows are normalized: a record for lookup, an array for render order.
 */
export type Diagram = {
  id: DiagramId;
  name: string;
  nodes: Record<NodeId, FinanceNode>;
  nodeOrder: NodeId[];
  flows: Record<FlowId, Flow>;
  flowOrder: FlowId[];
};

/**
 * The stored document. `diagrams` holds a single entry today; the collection
 * exists so adding tabs later is an append rather than a migration.
 */
export type FinanceDocument = {
  version: 1;
  diagrams: Diagram[];
  activeDiagramId: DiagramId;
  updatedAt: string | null;
};

export const DOCUMENT_VERSION = 1;

export const ANCHORS: Anchor[] = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];

export const NODE_KINDS: NodeKind[] = ['job', 'account', 'holding'];
