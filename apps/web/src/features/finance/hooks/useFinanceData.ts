import { useMutation } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  createEmptyDocument,
  getActiveDiagram,
  normalizeDocument,
  withActiveDiagram,
} from '@/features/finance/lib/document';
import * as ops from '@/features/finance/lib/operations';
import { err, ok, type Result } from '@/features/finance/lib/result';
import type {
  AssetCode,
  Diagram,
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

export function useFinanceData() {
  const store = useStoredDocument<FinanceDocument>({
    key: 'finance',
    normalize,
    placeholder: EMPTY_DOCUMENT,
  });

  /**
   * Run a transition against the active diagram. The change is evaluated inside
   * the write, on the freshest document, so two edits started together cannot
   * each build on pre-write state.
   */
  const editDiagram = useCallback(
    (change: DiagramChange) =>
      store.edit((doc) => {
        const current = getActiveDiagram(doc);
        const next = change(current);
        return next === current ? doc : withActiveDiagram(doc, next);
      }),
    [store],
  );

  const apply = useMutation({ mutationFn: (change: DiagramChange) => editDiagram(change) });
  const run = useCallback((change: DiagramChange) => apply.mutateAsync(change), [apply]);

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

    addJob: (position: Point) => run((d) => ops.addJob(d, { id: newId(), position })),
    addAccount: (position: Point) => run((d) => ops.addAccount(d, { id: newId(), position })),
    addHolding: (accountId: NodeId, asset: string, position: Point) =>
      runResult((d) => ops.addHolding(d, { id: newId(), accountId, asset, position })),

    moveNode: (id: NodeId, position: Point) => run((d) => ops.moveNode(d, id, position)),
    renameNode: (id: NodeId, name: string) => run((d) => ops.renameNode(d, id, name)),
    setNotes: (id: NodeId, notes: string) => run((d) => ops.setNotes(d, id, notes)),
    deleteNode: (id: NodeId) => run((d) => ops.deleteNode(d, id)),

    updateHolding: (id: NodeId, patch: Partial<Pick<HoldingNode, 'amount' | 'fees' | 'active'>>) =>
      run((d) => ops.updateHolding(d, id, patch)),

    addJobAsset: (jobId: NodeId, asset: string) => run((d) => ops.addJobAsset(d, jobId, asset)),
    setJobBalance: (jobId: NodeId, asset: AssetCode, amount: number | null) =>
      run((d) => ops.setJobBalance(d, jobId, asset, amount)),
    setJobAssetActive: (jobId: NodeId, asset: AssetCode, active: boolean) =>
      run((d) => ops.setJobAssetActive(d, jobId, asset, active)),

    connect: (input: Omit<Parameters<typeof ops.connect>[1], 'id'>) =>
      runResult((d) => ops.connect(d, { ...input, id: newId() })),
    updateFlow: (id: FlowId, patch: Parameters<typeof ops.updateFlow>[2]) =>
      run((d) => ops.updateFlow(d, id, patch)),
    deleteFlow: (id: FlowId) => run((d) => ops.deleteFlow(d, id)),
  };
}
