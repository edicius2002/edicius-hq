import { describe, expect, it } from 'vitest';

import {
  addDiagram,
  createEmptyDocument,
  deleteDiagram,
  duplicateDiagram,
  getActiveDiagram,
  renameDiagram,
  setActiveDiagram,
  withActiveDiagram,
} from '@/features/finance/lib/document';
import { addAccount } from '@/features/finance/lib/operations';
import type { FinanceDocument } from '@/features/finance/model/types';

const names = (doc: FinanceDocument) => doc.diagrams.map((diagram) => diagram.name);
const ids = (doc: FinanceDocument) => doc.diagrams.map((diagram) => diagram.id);

/** A document whose first diagram holds one account. */
function withContent(): FinanceDocument {
  const doc = createEmptyDocument('d1');
  const filled = addAccount(getActiveDiagram(doc), { id: 'a1', position: { x: 5, y: 6 } });
  return withActiveDiagram(doc, filled);
}

describe('the diagram collection', () => {
  it('adds a diagram and switches to it', () => {
    const doc = addDiagram(createEmptyDocument('d1'), 'd2');

    expect(ids(doc)).toEqual(['d1', 'd2']);
    expect(doc.activeDiagramId).toBe('d2');
    expect(getActiveDiagram(doc).nodeOrder).toEqual([]);
  });

  it('keeps names apart instead of repeating one', () => {
    let doc = addDiagram(createEmptyDocument('d1'), 'd2');
    doc = addDiagram(doc, 'd3');

    expect(names(doc)).toEqual(['Cash flow', 'Cash flow 2', 'Cash flow 3']);
  });

  it('never mutates the document it is given', () => {
    const before = createEmptyDocument('d1');
    addDiagram(before, 'd2');
    expect(ids(before)).toEqual(['d1']);
  });

  describe('duplicate', () => {
    it('copies the contents and switches to the copy', () => {
      const doc = duplicateDiagram(withContent(), 'd1', 'd2');

      expect(doc.activeDiagramId).toBe('d2');
      expect(getActiveDiagram(doc).nodes.a1.position).toEqual({ x: 5, y: 6 });
      expect(names(doc)).toEqual(['Cash flow', 'Cash flow copy']);
    });

    it('leaves the original alone when the copy is edited', () => {
      let doc = duplicateDiagram(withContent(), 'd1', 'd2');
      doc = withActiveDiagram(
        doc,
        addAccount(getActiveDiagram(doc), { id: 'a2', position: { x: 0, y: 0 } }),
      );

      expect(doc.diagrams[0].nodeOrder).toEqual(['a1']);
      expect(doc.diagrams[1].nodeOrder).toEqual(['a1', 'a2']);
    });

    it('ignores a source that is not there', () => {
      const doc = createEmptyDocument('d1');
      expect(duplicateDiagram(doc, 'ghost', 'd2')).toBe(doc);
    });
  });

  describe('rename and switch', () => {
    it('renames only the one asked for', () => {
      const doc = renameDiagram(addDiagram(createEmptyDocument('d1'), 'd2'), 'd1', 'Personal');
      expect(names(doc)).toEqual(['Personal', 'Cash flow 2']);
    });

    it('switches to a diagram that exists and ignores one that does not', () => {
      const doc = addDiagram(createEmptyDocument('d1'), 'd2');

      expect(setActiveDiagram(doc, 'd1').activeDiagramId).toBe('d1');
      expect(setActiveDiagram(doc, 'ghost')).toBe(doc);
    });
  });

  describe('delete', () => {
    it('lands on the neighbour rather than jumping to the end', () => {
      let doc = addDiagram(addDiagram(createEmptyDocument('d1'), 'd2'), 'd3');
      doc = setActiveDiagram(doc, 'd2');

      const after = deleteDiagram(doc, 'd2', 'fallback');
      expect(ids(after)).toEqual(['d1', 'd3']);
      expect(after.activeDiagramId).toBe('d3');
    });

    it('lands on the last one when the last is removed', () => {
      let doc = addDiagram(createEmptyDocument('d1'), 'd2');
      doc = setActiveDiagram(doc, 'd2');

      expect(deleteDiagram(doc, 'd2', 'fallback').activeDiagramId).toBe('d1');
    });

    it('leaves the active one alone when another is removed', () => {
      let doc = addDiagram(createEmptyDocument('d1'), 'd2');
      doc = setActiveDiagram(doc, 'd2');

      expect(deleteDiagram(doc, 'd1', 'fallback').activeDiagramId).toBe('d2');
    });

    it('leaves an empty diagram behind when the last one goes', () => {
      const after = deleteDiagram(withContent(), 'd1', 'fresh');

      // A document always needs an active diagram, so it cannot end up with none.
      expect(after.diagrams).toHaveLength(1);
      expect(after.activeDiagramId).toBe('fresh');
      expect(getActiveDiagram(after).nodeOrder).toEqual([]);
    });

    it('ignores an id that is not there', () => {
      const doc = createEmptyDocument('d1');
      expect(deleteDiagram(doc, 'ghost', 'fallback')).toBe(doc);
    });
  });
});
