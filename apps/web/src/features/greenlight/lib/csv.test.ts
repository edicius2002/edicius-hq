import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCsv } from '@/features/greenlight/lib/csv';

const FIXTURE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/timerecords-sample.csv'),
  'utf8',
);

describe('parseCsv', () => {
  it('parses the real TimeRecords export: 23 quoted rows, commas inside Notes', () => {
    const rows = parseCsv(FIXTURE);

    expect(rows).toHaveLength(23);
    expect(rows[0]?.['record type']).toBe('Deliverable');
    expect(rows[0]?.['date/start']).toBe('2026-08-03T00:00');
    expect(rows[0]?.amount).toBe('1733.44');
    expect(rows[0]?.notes).toBe(
      '|554, 486, 556, 496, 544, 506, 536, 539, 549, 131, 189, 191, 174, 184, 171, 181',
    );
    expect(rows.filter((row) => row['record type'] === 'Expense')).toHaveLength(4);
  });

  it('keeps commas that sit inside quotes', () => {
    const rows = parseCsv('Name,Notes\n"A","one, two, three"\n');
    expect(rows).toEqual([{ name: 'A', notes: 'one, two, three' }]);
  });

  it('treats CRLF the same as LF', () => {
    const rows = parseCsv('Date,Amount\r\n2026-08-03,10\r\n2026-08-04,20\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ date: '2026-08-03', amount: '10' });
    expect(rows[1]).toEqual({ date: '2026-08-04', amount: '20' });
  });

  it('strips a UTF-8 BOM from the first header', () => {
    const rows = parseCsv('\uFEFFDate,Amount\n2026-08-03,10\n');
    expect(rows).toEqual([{ date: '2026-08-03', amount: '10' }]);
  });

  it('returns no rows for empty input or a header with no data', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('Date,Amount\n')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    const rows = parseCsv('Name,Notes\n"A","said ""hello"""\n');
    expect(rows[0]?.notes).toBe('said "hello"');
  });
});
