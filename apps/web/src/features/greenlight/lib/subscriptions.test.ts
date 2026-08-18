import { describe, expect, it } from 'vitest';

import { parseCsv } from '@/features/greenlight/lib/csv';
import { importGreenlightCsv } from '@/features/greenlight/lib/processRows';
import {
  detectToolWidgets,
  mergeDetectedWidgets,
  pruneToolWidgets,
  toggleToolWidget,
  TOOL_RATES,
} from '@/features/greenlight/lib/subscriptions';

const EXPENSE_CSV = `Record Type,Date/Start,Amount,Currency,Notes
Expense,2026-04-17T00:00,30,USD,"1. VSCode Copilot
2. Cursor Pro
Project: NES Code Editing"
Expense,2026-05-16T00:00,10,USD,"1. VSCode Copilot
SPL: Someone"
Expense,2026-05-29T00:00,20,USD,"1. Cursor Pro
SPL: Someone"
Deliverable,2026-07-28T00:00,20,USD,NES-COD-R-54|Cursor subscription
`;

describe('tool subscription widgets', () => {
  it('uses the rates billed in the TimeRecords expense rows', () => {
    expect(TOOL_RATES.vscode).toBe(10);
    expect(TOOL_RATES.cursor).toBe(20);
  });

  it('detects both tools from a single multi-line expense note', () => {
    const widgets = detectToolWidgets(parseCsv(EXPENSE_CSV));
    expect(widgets['2026-04']).toEqual(['vscode', 'cursor']);
  });

  it('merges separate expense rows of the same month, capped at one per tool', () => {
    const widgets = detectToolWidgets(parseCsv(EXPENSE_CSV));
    expect(widgets['2026-05']).toEqual(['vscode', 'cursor']);
  });

  it('ignores Deliverable rows that merely mention a subscription', () => {
    const widgets = detectToolWidgets(parseCsv(EXPENSE_CSV));
    expect(widgets['2026-07']).toBeUndefined();
  });

  it('detects Spanish Gasto rows', () => {
    const widgets = detectToolWidgets(
      parseCsv(`Tipo,Fecha,Monto,Notas\nGasto,2026-06-28,10,1. Cursor Pro\n`),
    );
    expect(widgets['2026-06']).toEqual(['cursor']);
  });

  it('exposes detected widgets through the CSV import', () => {
    const csv = `Record Type,Date/Start,Amount,Currency,Notes
Deliverable,2026-04-17T00:00,388,USD,work
Expense,2026-04-17T00:00,10,USD,1. VSCode Copilot
`;
    expect(importGreenlightCsv(csv).widgets).toEqual({ '2026-04': ['vscode'] });
  });

  describe('mergeDetectedWidgets', () => {
    it('seeds months that have no entry yet', () => {
      expect(mergeDetectedWidgets({}, { '2026-04': ['vscode'] })).toEqual({
        '2026-04': ['vscode'],
      });
    });

    it('never overwrites a month the user already touched', () => {
      const merged = mergeDetectedWidgets(
        { '2026-04': ['cursor'] },
        { '2026-04': ['vscode', 'cursor'], '2026-05': ['vscode'] },
      );
      expect(merged['2026-04']).toEqual(['cursor']);
      expect(merged['2026-05']).toEqual(['vscode']);
    });

    it('treats an emptied month as touched so a manual removal survives re-import', () => {
      const merged = mergeDetectedWidgets({ '2026-04': [] }, { '2026-04': ['vscode', 'cursor'] });
      expect(merged['2026-04']).toEqual([]);
    });
  });

  describe('pruneToolWidgets', () => {
    it('drops a month that has no weeks with data, so it can be redetected', () => {
      const stats = {
        '2026-04-17': { Deliverable: { amount: 388, details: [] }, currency: 'USD' },
      };
      const pruned = pruneToolWidgets(
        { '2026-04': ['vscode'], '2026-05': [], '2026-06': ['cursor'] },
        stats,
      );
      expect(pruned).toEqual({ '2026-04': ['vscode'] });
      // The empty May entry used to block reseeding forever.
      expect(mergeDetectedWidgets(pruned, { '2026-05': ['vscode'] })['2026-05']).toEqual([
        'vscode',
      ]);
    });

    it('keeps an emptied month that still has weeks, so a manual removal survives', () => {
      const stats = {
        '2026-04-17': { Deliverable: { amount: 388, details: [] }, currency: 'USD' },
      };
      expect(pruneToolWidgets({ '2026-04': [] }, stats)).toEqual({ '2026-04': [] });
    });
  });

  describe('toggleToolWidget', () => {
    it('adds a tool to a month with no entry', () => {
      expect(toggleToolWidget({}, '2026-07', 'cursor')).toEqual({ '2026-07': ['cursor'] });
    });

    it('keeps a stable tool order when adding the second tool', () => {
      const next = toggleToolWidget({ '2026-07': ['cursor'] }, '2026-07', 'vscode');
      expect(next['2026-07']).toEqual(['vscode', 'cursor']);
    });

    it('removes a tool and leaves an empty array behind', () => {
      const next = toggleToolWidget({ '2026-04': ['vscode'] }, '2026-04', 'vscode');
      expect(next['2026-04']).toEqual([]);
      expect('2026-04' in next).toBe(true);
    });

    it('leaves other months untouched', () => {
      const next = toggleToolWidget({ '2026-04': ['vscode'] }, '2026-05', 'cursor');
      expect(next['2026-04']).toEqual(['vscode']);
      expect(next['2026-05']).toEqual(['cursor']);
    });
  });
});
