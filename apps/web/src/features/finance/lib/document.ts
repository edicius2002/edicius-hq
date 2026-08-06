import { FRAME_MIN_SIZE } from '@/features/finance/lib/frames';
import {
  ANCHORS,
  DOCUMENT_VERSION,
  NODE_KINDS,
  type Anchor,
  type AssetCode,
  type Balance,
  type Diagram,
  type DiagramId,
  type Fee,
  type FeePolicy,
  type FinanceDocument,
  type FinanceNode,
  type Flow,
  type Frame,
  type FrameId,
  type NodeId,
  type Point,
  type Size,
} from '@/features/finance/model/types';

export const DEFAULT_DIAGRAM_NAME = 'Cash flow';
export const DEFAULT_ASSET: AssetCode = 'USD';
export const DEFAULT_FRAME_NAME = 'Frame';

export function createEmptyDiagram(id: DiagramId, name = DEFAULT_DIAGRAM_NAME): Diagram {
  return {
    id,
    name,
    nodes: {},
    nodeOrder: [],
    flows: {},
    flowOrder: [],
    frames: {},
    frameOrder: [],
  };
}

export function createEmptyDocument(diagramId: DiagramId): FinanceDocument {
  return {
    version: DOCUMENT_VERSION,
    diagrams: [createEmptyDiagram(diagramId)],
    activeDiagramId: diagramId,
    updatedAt: null,
  };
}

export function getActiveDiagram(doc: FinanceDocument): Diagram {
  return doc.diagrams.find((diagram) => diagram.id === doc.activeDiagramId) ?? doc.diagrams[0];
}

// --- the diagram collection ----------------------------------------------
// Pure transitions over the document, mirroring the ones over a diagram. Ids
// arrive from the caller so these stay deterministic.

/** A name that does not collide with the diagrams already there. */
function uniqueName(doc: FinanceDocument, wanted: string): string {
  const taken = new Set(doc.diagrams.map((diagram) => diagram.name));
  if (!taken.has(wanted)) return wanted;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${wanted} ${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function addDiagram(
  doc: FinanceDocument,
  id: DiagramId,
  name = DEFAULT_DIAGRAM_NAME,
): FinanceDocument {
  const diagram = createEmptyDiagram(id, uniqueName(doc, name));
  return { ...doc, diagrams: [...doc.diagrams, diagram], activeDiagramId: id };
}

/**
 * Copy a diagram, contents and all. Node ids are kept: they only have to be
 * unique within their own diagram, and reusing them keeps the copy identical.
 */
export function duplicateDiagram(
  doc: FinanceDocument,
  sourceId: DiagramId,
  id: DiagramId,
): FinanceDocument {
  const source = doc.diagrams.find((diagram) => diagram.id === sourceId);
  if (!source) return doc;

  const copy: Diagram = { ...source, id, name: uniqueName(doc, `${source.name} copy`) };
  return { ...doc, diagrams: [...doc.diagrams, copy], activeDiagramId: id };
}

export function renameDiagram(doc: FinanceDocument, id: DiagramId, name: string): FinanceDocument {
  return {
    ...doc,
    diagrams: doc.diagrams.map((diagram) => (diagram.id === id ? { ...diagram, name } : diagram)),
  };
}

export function setActiveDiagram(doc: FinanceDocument, id: DiagramId): FinanceDocument {
  return doc.diagrams.some((diagram) => diagram.id === id) ? { ...doc, activeDiagramId: id } : doc;
}

/**
 * Remove a diagram. The document always needs one, so removing the last leaves
 * an empty diagram behind rather than nothing. `fallbackId` names that one.
 */
export function deleteDiagram(
  doc: FinanceDocument,
  id: DiagramId,
  fallbackId: DiagramId,
): FinanceDocument {
  const index = doc.diagrams.findIndex((diagram) => diagram.id === id);
  if (index < 0) return doc;

  const remaining = doc.diagrams.filter((diagram) => diagram.id !== id);
  if (!remaining.length) {
    return { ...doc, diagrams: [createEmptyDiagram(fallbackId)], activeDiagramId: fallbackId };
  }

  // Land on the neighbour rather than jumping to the far end of the bar.
  const next = remaining[Math.min(index, remaining.length - 1)];
  return {
    ...doc,
    diagrams: remaining,
    activeDiagramId: doc.activeDiagramId === id ? next.id : doc.activeDiagramId,
  };
}

/** Replace the active diagram, leaving the rest of the document untouched. */
export function withActiveDiagram(doc: FinanceDocument, next: Diagram): FinanceDocument {
  return {
    ...doc,
    diagrams: doc.diagrams.map((diagram) => (diagram.id === next.id ? next : diagram)),
  };
}

// --- normalization -------------------------------------------------------
// Everything below parses untrusted JSON coming back from storage. It repairs
// what it can and drops what would break an invariant, so the rest of the
// feature can rely on the shape without re-checking it.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Finite number or null — an empty amount is a real state, not zero. */
function toAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPoint(value: unknown): Point {
  if (!isRecord(value)) return { x: 0, y: 0 };
  return { x: toAmount(value.x) ?? 0, y: toAmount(value.y) ?? 0 };
}

function toFee(value: unknown): Fee | null {
  if (!isRecord(value)) return null;
  const amount = toAmount(value.value);
  if (amount === null) return null;
  const type = value.type === 'fixed' ? 'fixed' : 'percent';
  // A percent above 100 would flip the transfer negative.
  const clamped = type === 'percent' ? Math.min(Math.max(amount, 0), 100) : Math.max(amount, 0);
  return { value: clamped, type };
}

function toFeePolicy(value: unknown): FeePolicy {
  if (!isRecord(value)) return { in: null, out: null };
  return { in: toFee(value.in), out: toFee(value.out) };
}

function toAsset(value: unknown, fallback = DEFAULT_ASSET): AssetCode {
  const text = toText(value).trim().toUpperCase();
  return text || fallback;
}

function toBalances(value: unknown): Balance[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<AssetCode>();
  const balances: Balance[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const asset = toAsset(entry.asset, '');
    if (!asset || seen.has(asset)) continue;
    seen.add(asset);
    balances.push({
      asset,
      amount: toAmount(entry.amount),
      active: entry.active !== false,
    });
  }
  return balances;
}

function toAnchor(value: unknown, fallback: Anchor): Anchor {
  return ANCHORS.includes(value as Anchor) ? (value as Anchor) : fallback;
}

function toNode(value: unknown): FinanceNode | null {
  if (!isRecord(value)) return null;
  const id = toText(value.id);
  const kind = value.kind;
  if (!id || !NODE_KINDS.includes(kind as FinanceNode['kind'])) return null;

  const base = {
    id,
    name: toText(value.name),
    notes: toText(value.notes),
    position: toPoint(value.position),
  };

  if (kind === 'job') {
    return { ...base, kind: 'job', balances: toBalances(value.balances) };
  }

  if (kind === 'account') {
    return { ...base, kind: 'account' };
  }

  const accountId = toText(value.accountId);
  if (!accountId) return null;
  return {
    ...base,
    kind: 'holding',
    accountId,
    asset: toAsset(value.asset),
    amount: toAmount(value.amount),
    fees: toFeePolicy(value.fees),
    active: value.active !== false,
  };
}

function toFlow(value: unknown): Flow | null {
  if (!isRecord(value)) return null;
  const id = toText(value.id);
  const from = toText(value.from);
  const to = toText(value.to);
  if (!id || !from || !to || from === to) return null;

  const offset = isRecord(value.labelOffset) ? toPoint(value.labelOffset) : null;
  return {
    id,
    from,
    to,
    fromAnchor: toAnchor(value.fromAnchor, 'r'),
    toAnchor: toAnchor(value.toAnchor, 'l'),
    amount: toAmount(value.amount),
    asset: toAsset(value.asset),
    label: toText(value.label),
    notes: toText(value.notes),
    labelOffset: offset,
  };
}

function toSize(value: unknown): Size {
  if (!isRecord(value)) return { ...FRAME_MIN_SIZE };
  return {
    width: Math.max(FRAME_MIN_SIZE.width, toAmount(value.width) ?? 0),
    height: Math.max(FRAME_MIN_SIZE.height, toAmount(value.height) ?? 0),
  };
}

function toFrame(value: unknown): Frame | null {
  if (!isRecord(value)) return null;
  const id = toText(value.id);
  if (!id) return null;

  return {
    id,
    name: toText(value.name, DEFAULT_FRAME_NAME) || DEFAULT_FRAME_NAME,
    position: toPoint(value.position),
    size: toSize(value.size),
  };
}

/** Keep the stored order, then append anything the order array forgot. */
function toOrder<T>(stored: unknown, byId: Record<string, T>): string[] {
  const known = new Set(Object.keys(byId));
  const order: string[] = [];
  if (Array.isArray(stored)) {
    for (const id of stored) {
      if (typeof id === 'string' && known.has(id) && !order.includes(id)) order.push(id);
    }
  }
  for (const id of known) if (!order.includes(id)) order.push(id);
  return order;
}

function toDiagram(value: unknown, fallbackId: DiagramId): Diagram | null {
  if (!isRecord(value)) return null;
  const id = toText(value.id) || fallbackId;

  const nodes: Record<NodeId, FinanceNode> = {};
  const rawNodes = Array.isArray(value.nodes) ? value.nodes : Object.values(value.nodes ?? {});
  for (const raw of rawNodes) {
    const node = toNode(raw);
    if (node) nodes[node.id] = node;
  }

  // A holding whose account vanished cannot be placed or totalled.
  for (const node of Object.values(nodes)) {
    if (node.kind === 'holding' && nodes[node.accountId]?.kind !== 'account') {
      delete nodes[node.id];
    }
  }

  const flows: Record<string, Flow> = {};
  const rawFlows = Array.isArray(value.flows) ? value.flows : Object.values(value.flows ?? {});
  for (const raw of rawFlows) {
    const flow = toFlow(raw);
    // Drop dangling flows rather than carrying edges to nodes that are gone.
    if (flow && nodes[flow.from] && nodes[flow.to]) flows[flow.id] = flow;
  }

  // Frames arrived after the first stored documents, so a diagram without them
  // is not a broken one: it simply has none.
  const frames: Record<FrameId, Frame> = {};
  const rawFrames = Array.isArray(value.frames) ? value.frames : Object.values(value.frames ?? {});
  for (const raw of rawFrames) {
    const frame = toFrame(raw);
    if (frame) frames[frame.id] = frame;
  }

  return {
    id,
    name: toText(value.name, DEFAULT_DIAGRAM_NAME) || DEFAULT_DIAGRAM_NAME,
    nodes,
    nodeOrder: toOrder(value.nodeOrder, nodes),
    flows,
    flowOrder: toOrder(value.flowOrder, flows),
    frames,
    frameOrder: toOrder(value.frameOrder, frames),
  };
}

/**
 * Parse a stored document. `fallbackId` names the diagram created when nothing
 * usable comes back, so this stays deterministic and free of id generation.
 */
export function normalizeDocument(value: unknown, fallbackId: DiagramId): FinanceDocument {
  if (!isRecord(value)) return createEmptyDocument(fallbackId);

  const diagrams: Diagram[] = [];
  if (Array.isArray(value.diagrams)) {
    for (const raw of value.diagrams) {
      const diagram = toDiagram(raw, fallbackId);
      if (diagram && !diagrams.some((item) => item.id === diagram.id)) diagrams.push(diagram);
    }
  }
  if (!diagrams.length) diagrams.push(createEmptyDiagram(fallbackId));

  const storedActive = toText(value.activeDiagramId);
  const activeDiagramId = diagrams.some((diagram) => diagram.id === storedActive)
    ? storedActive
    : diagrams[0].id;

  return {
    version: DOCUMENT_VERSION,
    diagrams,
    activeDiagramId,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  };
}
