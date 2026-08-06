import { describe, expect, it } from 'vitest';

import {
  createEmptyDocument,
  DEFAULT_DIAGRAM_NAME,
  getActiveDiagram,
  normalizeDocument,
  withActiveDiagram,
} from '@/features/finance/lib/document';

const FALLBACK = 'fallback-diagram';

function account(id: string) {
  return { id, kind: 'account', name: 'Bank', notes: '', position: { x: 0, y: 0 } };
}

function holding(id: string, accountId: string, asset = 'USD') {
  return {
    id,
    kind: 'holding',
    name: asset,
    notes: '',
    position: { x: 10, y: 10 },
    accountId,
    asset,
    amount: 100,
    fees: { in: null, out: null },
    active: true,
  };
}

describe('finance document', () => {
  it('creates a document holding one diagram, ready for more later', () => {
    const doc = createEmptyDocument('d1');
    expect(doc.diagrams).toHaveLength(1);
    expect(doc.activeDiagramId).toBe('d1');
    expect(getActiveDiagram(doc).nodes).toEqual({});
  });

  it('replaces only the active diagram and leaves the others alone', () => {
    const base = createEmptyDocument('d1');
    const first = getActiveDiagram(base);
    const doc = { ...base, diagrams: [first, { ...first, id: 'd2', name: 'Other' }] };

    const next = withActiveDiagram(doc, { ...getActiveDiagram(doc), name: 'Renamed' });

    expect(next.diagrams[0].name).toBe('Renamed');
    expect(next.diagrams[1].name).toBe('Other');
    expect(doc.diagrams[0].name).toBe(DEFAULT_DIAGRAM_NAME);
  });

  describe('normalization', () => {
    it('falls back to an empty document for junk input', () => {
      for (const junk of [null, undefined, 42, 'nope', []]) {
        const doc = normalizeDocument(junk, FALLBACK);
        expect(doc.diagrams).toHaveLength(1);
        expect(doc.activeDiagramId).toBe(FALLBACK);
      }
    });

    it('drops a holding whose account is gone', () => {
      const doc = normalizeDocument(
        {
          diagrams: [{ id: 'd1', nodes: [holding('h1', 'missing-account')] }],
          activeDiagramId: 'd1',
        },
        FALLBACK,
      );
      expect(getActiveDiagram(doc).nodes).toEqual({});
    });

    it('keeps a holding whose account is present', () => {
      const doc = normalizeDocument(
        {
          diagrams: [{ id: 'd1', nodes: [account('a1'), holding('h1', 'a1')] }],
          activeDiagramId: 'd1',
        },
        FALLBACK,
      );
      expect(Object.keys(getActiveDiagram(doc).nodes).sort()).toEqual(['a1', 'h1']);
    });

    it('drops flows that point at a node which no longer exists', () => {
      const doc = normalizeDocument(
        {
          diagrams: [
            {
              id: 'd1',
              nodes: [account('a1'), holding('h1', 'a1')],
              flows: [
                { id: 'f1', from: 'h1', to: 'a1', amount: 10 },
                { id: 'f2', from: 'h1', to: 'ghost', amount: 10 },
              ],
            },
          ],
          activeDiagramId: 'd1',
        },
        FALLBACK,
      );
      const diagram = getActiveDiagram(doc);
      expect(Object.keys(diagram.flows)).toEqual(['f1']);
      expect(diagram.flowOrder).toEqual(['f1']);
    });

    it('drops a flow whose ends are the same node', () => {
      const doc = normalizeDocument(
        {
          diagrams: [
            { id: 'd1', nodes: [account('a1')], flows: [{ id: 'f1', from: 'a1', to: 'a1' }] },
          ],
          activeDiagramId: 'd1',
        },
        FALLBACK,
      );
      expect(getActiveDiagram(doc).flows).toEqual({});
    });

    it('repairs an order array that misses ids or invents them', () => {
      const doc = normalizeDocument(
        {
          diagrams: [
            {
              id: 'd1',
              nodes: [account('a1'), account('a2')],
              nodeOrder: ['a2', 'ghost'],
            },
          ],
          activeDiagramId: 'd1',
        },
        FALLBACK,
      );
      // Stored order wins, the forgotten id is appended, the invented one is dropped.
      expect(getActiveDiagram(doc).nodeOrder).toEqual(['a2', 'a1']);
    });

    it('clamps a percent fee to 100 so a transfer cannot go negative', () => {
      const doc = normalizeDocument(
        {
          diagrams: [
            {
              id: 'd1',
              nodes: [
                account('a1'),
                {
                  ...holding('h1', 'a1'),
                  fees: { in: { value: 250, type: 'percent' }, out: null },
                },
              ],
            },
          ],
          activeDiagramId: 'd1',
        },
        FALLBACK,
      );
      const node = getActiveDiagram(doc).nodes.h1;
      expect(node.kind === 'holding' && node.fees.in).toEqual({ value: 100, type: 'percent' });
    });

    it('ignores fees stored on an account, since accounts never charge', () => {
      const doc = normalizeDocument(
        {
          diagrams: [
            {
              id: 'd1',
              nodes: [{ ...account('a1'), fees: { in: { value: 5, type: 'percent' }, out: null } }],
            },
          ],
          activeDiagramId: 'd1',
        },
        FALLBACK,
      );
      expect(getActiveDiagram(doc).nodes.a1).not.toHaveProperty('fees');
    });

    it('keeps an empty amount as null rather than turning it into zero', () => {
      const doc = normalizeDocument(
        {
          diagrams: [
            {
              id: 'd1',
              nodes: [account('a1'), { ...holding('h1', 'a1'), amount: '' }],
            },
          ],
          activeDiagramId: 'd1',
        },
        FALLBACK,
      );
      const node = getActiveDiagram(doc).nodes.h1;
      expect(node.kind === 'holding' && node.amount).toBeNull();
    });

    it('deduplicates job balances and defaults them to active', () => {
      const doc = normalizeDocument(
        {
          diagrams: [
            {
              id: 'd1',
              nodes: [
                {
                  id: 'j1',
                  kind: 'job',
                  name: 'Job',
                  notes: '',
                  position: { x: 0, y: 0 },
                  balances: [
                    { asset: 'usd', amount: 10 },
                    { asset: 'USD', amount: 99 },
                    { asset: 'PEN', amount: 5, active: false },
                  ],
                },
              ],
            },
          ],
          activeDiagramId: 'd1',
        },
        FALLBACK,
      );
      const node = getActiveDiagram(doc).nodes.j1;
      expect(node.kind === 'job' && node.balances).toEqual([
        { asset: 'USD', amount: 10, active: true },
        { asset: 'PEN', amount: 5, active: false },
      ]);
    });

    it('falls back to the first diagram when the active id is unknown', () => {
      const doc = normalizeDocument(
        { diagrams: [{ id: 'd1' }, { id: 'd2' }], activeDiagramId: 'gone' },
        FALLBACK,
      );
      expect(doc.activeDiagramId).toBe('d1');
      expect(doc.diagrams).toHaveLength(2);
    });
  });
});
