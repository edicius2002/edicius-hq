import { useMutation } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import {
  addDiagram,
  createEmptyDocument,
  deleteDiagram,
  duplicateDiagram,
  getActiveDiagram,
  normalizeDocument,
  renameDiagram,
  setActiveDiagram,
  withActiveDiagram,
} from '@/features/finance/lib/document';
import {
  canRedo,
  canUndo,
  createHistory,
  record,
  redo as redoStep,
  undo as undoStep,
  type History,
} from '@/features/finance/lib/history';
import * as ops from '@/features/finance/lib/operations';
import { err, ok, type Result } from '@/features/finance/lib/result';
import type {
  AssetCode,
  Diagram,
  DiagramId,
  FinanceDocument,
  FlowId,
  HoldingNode,
  NodeId,
  Point,
} from '@/features/finance/model/types';
import { useStoredDocument } from '@/shared/storage/useStoredDocument';

/**
 * Names the diagram created when storage is empty. A constant rather than a
 * generated id, so an unsaved diagram keeps the same identity across reloads.
 */
const DEFAULT_DIAGRAM_ID = 'default';

const EMPTY_DOCUMENT = createEmptyDocument(DEFAULT_DIAGRAM_ID);

function normalize(value: unknown): FinanceDocument {
  return normalizeDocument(value, DEFAULT_DIAGRAM_ID);
}

function newId(): string {
  return crypto.randomUUID();
}

type DiagramChange = (current: Diagram) => Diagram;

/** An edit and, when it is one of a rapid run, the key that merges it with them. */
type Edit = { change: DiagramChange; coalesceKey?: string };

export function useFinanceData() {
  const store = useStoredDocument<FinanceDocument>({
    key: 'finance',
    normalize,
    placeholder: EMPTY_DOCUMENT,
  });

  /**
   * Undo stacks, one per diagram, so a step back never touches a diagram the
   * user is not looking at. They live in memory: undo is for fixing what you
   * just did, and persisting them would cost a write per pointer move.
   */
  const histories = useRef(new Map<DiagramId, History<Diagram>>());
  const [steps, setSteps] = useState({ canUndo: false, canRedo: false });

  const historyOf = useCallback(
    (id: DiagramId) => histories.current.get(id) ?? createHistory<Diagram>(),
    [],
  );

  const rememberHistory = useCallback((id: DiagramId, history: History<Diagram>) => {
    histories.current.set(id, history);
    setSteps({ canUndo: canUndo(history), canRedo: canRedo(history) });
  }, []);

  /**
   * Run a transition against the active diagram. The change is evaluated inside
   * the write, on the freshest document, so two edits started together cannot
   * each build on pre-write state — and the history entry is recorded there too,
   * for the same reason.
   */
  const editDiagram = useCallback(
    ({ change, coalesceKey }: Edit) =>
      store.edit((doc) => {
        const current = getActiveDiagram(doc);
        const next = change(current);
        if (next === current) return doc;

        rememberHistory(current.id, record(historyOf(current.id), current, coalesceKey ?? null));
        return withActiveDiagram(doc, next);
      }),
    [historyOf, rememberHistory, store],
  );

  const apply = useMutation({ mutationFn: (edit: Edit) => editDiagram(edit) });
  const run = useCallback(
    (change: DiagramChange, coalesceKey?: string) => apply.mutateAsync({ change, coalesceKey }),
    [apply],
  );

  /** Move one step through the stack and persist whatever it lands on. */
  const step = useCallback(
    (direction: 'undo' | 'redo') =>
      store.edit((doc) => {
        const current = getActiveDiagram(doc);
        const move = direction === 'undo' ? undoStep : redoStep;
        const taken = move(historyOf(current.id), current);
        if (!taken) return doc;

        rememberHistory(current.id, taken.history);
        return withActiveDiagram(doc, taken.value);
      }),
    [historyOf, rememberHistory, store],
  );

  /**
   * Edit the document rather than one diagram: adding, switching, renaming and
   * removing. The undo flags follow whichever diagram ends up active, so the
   * buttons describe the one on screen instead of the one just left behind.
   */
  const editDocument = useCallback(
    (change: (doc: FinanceDocument) => FinanceDocument) =>
      store.edit((doc) => {
        const next = change(doc);
        if (next === doc) return doc;

        const history = historyOf(getActiveDiagram(next).id);
        setSteps({ canUndo: canUndo(history), canRedo: canRedo(history) });
        return next;
      }),
    [historyOf, store],
  );

  const forgetHistory = useCallback((id: DiagramId) => {
    histories.current.delete(id);
  }, []);

  /**
   * Run a transition that may refuse. The refusal is captured from inside the
   * write, so it is judged against current state rather than what was rendered,
   * and a refused change leaves the diagram — and storage — untouched.
   */
  const runResult = useCallback(
    async <E>(change: (current: Diagram) => Result<Diagram, E>): Promise<Result<void, E>> => {
      let failure: E | null = null;
      await run((current) => {
        const result = change(current);
        if (result.ok) return result.value;
        failure = result.error;
        return current;
      });
      return failure === null ? ok(undefined) : err(failure);
    },
    [run],
  );

  const document = store.data;
  const diagram = getActiveDiagram(document);

  return {
    document,
    diagram,
    isFetching: store.isFetching,
    isError: store.isError,
    isSaving: apply.isPending,

    canUndo: steps.canUndo,
    canRedo: steps.canRedo,
    undo: () => step('undo'),
    redo: () => step('redo'),

    diagrams: document.diagrams,
    activeDiagramId: document.activeDiagramId,
    addDiagram: () => editDocument((doc) => addDiagram(doc, newId())),
    duplicateDiagram: (id: DiagramId) => editDocument((doc) => duplicateDiagram(doc, id, newId())),
    renameDiagram: (id: DiagramId, name: string) =>
      editDocument((doc) => renameDiagram(doc, id, name)),
    selectDiagram: (id: DiagramId) => editDocument((doc) => setActiveDiagram(doc, id)),
    deleteDiagram: (id: DiagramId) =>
      editDocument((doc) => {
        const next = deleteDiagram(doc, id, newId());
        // Its stack is meaningless once the diagram is gone.
        if (next !== doc) forgetHistory(id);
        return next;
      }),

    // Structural edits get no key: each is a step of its own. Edits that fire in
    // runs — a drag, typing into a field — share one so undo goes back to before
    // the run rather than through it.
    addJob: (position: Point) => run((d) => ops.addJob(d, { id: newId(), position })),
    addAccount: (position: Point) => run((d) => ops.addAccount(d, { id: newId(), position })),
    addHolding: (accountId: NodeId, asset: string, position: Point) =>
      runResult((d) => ops.addHolding(d, { id: newId(), accountId, asset, position })),

    moveNode: (id: NodeId, position: Point) =>
      run((d) => ops.moveNode(d, id, position), `move:${id}`),
    renameNode: (id: NodeId, name: string) => run((d) => ops.renameNode(d, id, name), `name:${id}`),
    setNotes: (id: NodeId, notes: string) => run((d) => ops.setNotes(d, id, notes), `notes:${id}`),
    deleteNode: (id: NodeId) => run((d) => ops.deleteNode(d, id)),

    updateHolding: (id: NodeId, patch: Partial<Pick<HoldingNode, 'amount' | 'fees' | 'active'>>) =>
      run(
        (d) => ops.updateHolding(d, id, patch),
        // Toggling active is a deliberate one-off; amounts and fees are typed.
        'active' in patch ? undefined : `holding:${id}:${Object.keys(patch).join()}`,
      ),

    addJobAsset: (jobId: NodeId, asset: string) => run((d) => ops.addJobAsset(d, jobId, asset)),
    setJobBalance: (jobId: NodeId, asset: AssetCode, amount: number | null) =>
      run((d) => ops.setJobBalance(d, jobId, asset, amount), `job:${jobId}:${asset}`),
    setJobAssetActive: (jobId: NodeId, asset: AssetCode, active: boolean) =>
      run((d) => ops.setJobAssetActive(d, jobId, asset, active)),

    connect: (input: Omit<Parameters<typeof ops.connect>[1], 'id'>) =>
      runResult((d) => ops.connect(d, { ...input, id: newId() })),
    updateFlow: (id: FlowId, patch: Parameters<typeof ops.updateFlow>[2]) =>
      run((d) => ops.updateFlow(d, id, patch), `flow:${id}:${Object.keys(patch).join()}`),
    deleteFlow: (id: FlowId) => run((d) => ops.deleteFlow(d, id)),
  };
}
