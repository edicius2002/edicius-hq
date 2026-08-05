import { parseCsv, valueFor, type CsvRow } from '@/features/greenlight/lib/csv';
import { parseAmount } from '@/features/greenlight/lib/parseAmount';
import { detectToolWidgets } from '@/features/greenlight/lib/subscriptions';
import type { DayStats, ToolWidgets } from '@/features/greenlight/model/types';

const DEFAULT_CURRENCY = 'USD';

export function processGreenlightRows(rows: CsvRow[]): Record<string, DayStats> {
  const stats: Record<string, DayStats> = {};

  for (const row of rows) {
    const date = valueFor(row, ['date/start', 'date', 'fecha', 'start']).split('T')[0];
    const recordType = valueFor(row, ['record type', 'tipo', 'type']);
    const amount = parseAmount(valueFor(row, ['amount', 'monto', 'importe']));
    const currency = valueFor(row, ['currency', 'moneda']) || DEFAULT_CURRENCY;
    const notes = valueFor(row, ['notes', 'notas', 'descripcion', 'description']);

    if (!date || !recordType) continue;
    const lowerType = recordType.toLowerCase();
    if (!lowerType.includes('deliverable') && !lowerType.includes('entregable')) continue;

    if (!stats[date]) {
      stats[date] = {
        Deliverable: { amount: 0, details: [] },
        currency,
      };
    }

    stats[date].Deliverable.amount += amount;
    if (notes) stats[date].Deliverable.details.push(notes.replaceAll('\n', '; '));
  }

  return stats;
}

export function importGreenlightCsv(content: string): {
  stats: Record<string, DayStats>;
  widgets: ToolWidgets;
  rowsRead: number;
  daysGenerated: number;
} {
  const rows = parseCsv(content);
  if (!rows.length) {
    throw new Error('No valid rows found in the CSV.');
  }

  const stats = processGreenlightRows(rows);
  const daysGenerated = Object.keys(stats).length;
  if (!daysGenerated) {
    throw new Error('CSV has no rows with a recognizable date and Deliverable/Entregable type.');
  }

  return { stats, widgets: detectToolWidgets(rows), rowsRead: rows.length, daysGenerated };
}
