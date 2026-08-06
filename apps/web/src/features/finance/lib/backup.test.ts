import { describe, expect, it } from 'vitest';

import {
  backupFilename,
  createBackup,
  describeRestoreError,
  readBackup,
  BACKUP_APP,
  BACKUP_KIND,
  BACKUP_VERSION,
} from '@/features/finance/lib/backup';
import { createEmptyDiagram, createEmptyDocument } from '@/features/finance/lib/document';
import { addAccount, addFrame, addJob } from '@/features/finance/lib/operations';
import type { FinanceDocument } from '@/features/finance/model/types';

const FALLBACK = 'fallback';

function populated(): FinanceDocument {
  let diagram = createEmptyDiagram('d1', 'Cash flow');
  diagram = addJob(diagram, { id: 'j1', position: { x: 40, y: 40 } });
  diagram = addAccount(diagram, { id: 'a1', position: { x: 400, y: 40 } });
  diagram = addFrame(diagram, {
    id: 'f1',
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    name: 'Savings',
  });

  const second = createEmptyDiagram('d2', 'Spending');
  return { version: 1, diagrams: [diagram, second], activeDiagramId: 'd2', updatedAt: null };
}

function roundTrip(document: FinanceDocument): FinanceDocument {
  const result = readBackup(
    JSON.stringify(createBackup(document, '2026-08-06T10:00:00.000Z')),
    FALLBACK,
  );
  if (!result.ok) throw new Error(`expected a readable backup, got ${result.error.code}`);
  return result.value;
}

describe('createBackup', () => {
  it('says what it is and when it was made', () => {
    const backup = createBackup(createEmptyDocument('d1'), '2026-08-06T10:00:00.000Z');
    expect(backup.app).toBe(BACKUP_APP);
    expect(backup.kind).toBe(BACKUP_KIND);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.exportedAt).toBe('2026-08-06T10:00:00.000Z');
  });

  it('carries the document unchanged', () => {
    const document = populated();
    expect(createBackup(document, '2026-08-06T10:00:00.000Z').document).toBe(document);
  });
});

describe('backupFilename', () => {
  it('is named for the day it was taken', () => {
    expect(backupFilename('2026-08-06T10:00:00.000Z')).toBe('finance-backup-2026-08-06.json');
  });

  it('still produces a usable name when the timestamp makes no sense', () => {
    expect(backupFilename('')).toBe('finance-backup-unknown.json');
    expect(backupFilename('later')).toBe('finance-backup-unknown.json');
  });
});

describe('readBackup', () => {
  it('restores exactly what was exported', () => {
    const document = populated();
    expect(roundTrip(document)).toEqual(document);
  });

  it('keeps every diagram, not just the active one', () => {
    const restored = roundTrip(populated());
    expect(restored.diagrams.map((diagram) => diagram.name)).toEqual(['Cash flow', 'Spending']);
    expect(restored.activeDiagramId).toBe('d2');
  });

  it('keeps the frames a diagram was carrying', () => {
    const restored = roundTrip(populated());
    expect(Object.keys(restored.diagrams[0].frames)).toEqual(['f1']);
    expect(restored.diagrams[0].frames.f1.name).toBe('Savings');
  });

  it('takes a bare document, which is what storage itself holds', () => {
    const document = populated();
    const result = readBackup(JSON.stringify(document), FALLBACK);
    expect(result.ok && result.value.diagrams).toHaveLength(2);
  });

  it('refuses a file that is not JSON', () => {
    const result = readBackup('not json at all', FALLBACK);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('unreadable');
  });

  it('refuses JSON that is not a backup, rather than restoring nothing over everything', () => {
    for (const text of [
      '{"holiday":"photo"}',
      '[1,2,3]',
      'null',
      '"a string"',
      '{"document":{}}',
    ]) {
      const result = readBackup(text, FALLBACK);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('not-a-backup');
    }
  });

  it('salvages what it can from a damaged diagram instead of failing whole', () => {
    const text = JSON.stringify({
      app: BACKUP_APP,
      document: {
        diagrams: [
          { id: 'd1', name: 'Cash flow', nodes: [{ id: 'j1', kind: 'job' }, { kind: 'job' }] },
        ],
        activeDiagramId: 'd1',
      },
    });

    const result = readBackup(text, FALLBACK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The node with no id could not be placed; the one with an id survived.
    expect(Object.keys(result.value.diagrams[0].nodes)).toEqual(['j1']);
  });

  it('imports a file written before frames existed', () => {
    const text = JSON.stringify({
      app: BACKUP_APP,
      kind: BACKUP_KIND,
      version: 1,
      exportedAt: '2026-08-05T10:00:00.000Z',
      document: {
        version: 1,
        activeDiagramId: 'd1',
        updatedAt: null,
        diagrams: [
          {
            id: 'd1',
            name: 'Cash flow',
            nodes: [{ id: 'a1', kind: 'account', name: 'Bank', position: { x: 10, y: 20 } }],
            nodeOrder: ['a1'],
            flows: [],
            flowOrder: [],
          },
        ],
      },
    });

    const result = readBackup(text, FALLBACK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diagrams[0].frames).toEqual({});
    expect(result.value.diagrams[0].frameOrder).toEqual([]);
    expect(result.value.diagrams[0].nodes.a1.name).toBe('Bank');
  });

  it('falls back to a usable document when the file holds no diagrams at all', () => {
    const result = readBackup(JSON.stringify({ diagrams: [] }), FALLBACK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diagrams).toHaveLength(1);
    expect(result.value.activeDiagramId).toBe(FALLBACK);
  });
});

describe('describeRestoreError', () => {
  it('says nothing was changed, since nothing was', () => {
    expect(describeRestoreError({ code: 'not-a-backup' })).toContain('Nothing was changed');
    expect(describeRestoreError({ code: 'unreadable' })).toContain('not JSON');
  });
});
