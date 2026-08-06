import { describe, expect, it } from 'vitest';

import {
  createEmptyDiagram,
  normalizeDocument,
  getActiveDiagram,
} from '@/features/finance/lib/document';
import { addAccount, addHolding, deleteNode } from '@/features/finance/lib/operations';
import type { Diagram, HoldingNode } from '@/features/finance/model/types';

const origin = { x: 0, y: 0 };

function expectOk<T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function holdingsOf(diagram: Diagram): HoldingNode[] {
  return Object.values(diagram.nodes).filter(
    (node): node is HoldingNode => node.kind === 'holding',
  );
}

/**
 * A holding only exists as part of an account — unlike an account or a job, it is
 * never a standalone entity. Every route into and out of the model has to hold
 * that line, so they are all pinned here in one place.
 */
describe('a holding cannot exist without its account', () => {
  it('cannot be created against an account that is not there', () => {
    const result = addHolding(createEmptyDiagram('d1'), {
      id: 'h1',
      accountId: 'ghost',
      asset: 'USD',
      position: origin,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('account-missing');
  });

  it('cannot be created against a job or another holding', () => {
    let diagram = addAccount(createEmptyDiagram('d1'), { id: 'a1', position: origin });
    diagram = expectOk(
      addHolding(diagram, { id: 'h1', accountId: 'a1', asset: 'USD', position: origin }),
    );

    const onHolding = addHolding(diagram, {
      id: 'h2',
      accountId: 'h1',
      asset: 'PEN',
      position: origin,
    });
    expect(onHolding.ok === false && onHolding.error.code).toBe('account-missing');
  });

  it('is removed with the account it belongs to', () => {
    let diagram = addAccount(createEmptyDiagram('d1'), { id: 'a1', position: origin });
    diagram = expectOk(
      addHolding(diagram, { id: 'h1', accountId: 'a1', asset: 'USD', position: origin }),
    );
    diagram = expectOk(
      addHolding(diagram, { id: 'h2', accountId: 'a1', asset: 'PEN', position: origin }),
    );

    expect(holdingsOf(deleteNode(diagram, 'a1'))).toEqual([]);
  });

  it('is dropped on load when its account is gone from storage', () => {
    const doc = normalizeDocument(
      {
        diagrams: [
          {
            id: 'd1',
            nodes: [
              {
                id: 'orphan',
                kind: 'holding',
                name: 'USD',
                notes: '',
                position: origin,
                accountId: 'a-that-no-longer-exists',
                asset: 'USD',
                amount: 500,
                fees: { in: null, out: null },
                active: true,
              },
            ],
          },
        ],
        activeDiagramId: 'd1',
      },
      'fallback',
    );

    expect(holdingsOf(getActiveDiagram(doc))).toEqual([]);
  });

  it('is dropped on load when it names no account at all', () => {
    const doc = normalizeDocument(
      {
        diagrams: [
          {
            id: 'd1',
            nodes: [
              {
                id: 'loose',
                kind: 'holding',
                name: 'USD',
                notes: '',
                position: origin,
                asset: 'USD',
                amount: 500,
                fees: { in: null, out: null },
                active: true,
              },
            ],
          },
        ],
        activeDiagramId: 'd1',
      },
      'fallback',
    );

    expect(holdingsOf(getActiveDiagram(doc))).toEqual([]);
  });

  it('survives its own deletion without taking the account down', () => {
    let diagram = addAccount(createEmptyDiagram('d1'), { id: 'a1', position: origin });
    diagram = expectOk(
      addHolding(diagram, { id: 'h1', accountId: 'a1', asset: 'USD', position: origin }),
    );

    // An account with no assets is a perfectly ordinary state.
    const after = deleteNode(diagram, 'h1');
    expect(after.nodes.a1).toBeDefined();
    expect(holdingsOf(after)).toEqual([]);
  });
});
