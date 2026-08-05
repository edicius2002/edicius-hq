import { parseCsv, valueFor, type CsvRow } from '@/features/greenlight/lib/csv';
import { parseAmount } from '@/features/greenlight/lib/parseAmount';
import type { DayStats } from '@/features/greenlight/model/types';

const DEFAULT_CURRENCY = 'USD';

export function extractTaskBreakdown(notes: string): { attempter: number; reviewer: number } {
  const attempterMatch = notes.match(/Attempter:\s*(\d+)/i);
  const reviewerMatch = notes.match(/Reviewer:\s*(\d+)/i);
  const attempter = attempterMatch ? Number(attempterMatch[1]) : 0;
  const reviewer = reviewerMatch ? Number(reviewerMatch[1]) : 0;
  if (attempter || reviewer) return { attempter, reviewer };

  const totalMatch = notes.match(/Total Delivered Tasks:\s*(\d+)/i);
  if (totalMatch) {
    return { attempter: Number(totalMatch[1]), reviewer: 0 };
  }

  // TimeRecords export: "CODE|id, id, id |" — count numeric task IDs after the pipe.
  const pipeSection = notes.includes('|') ? notes.split('|').slice(1).join('|') : '';
  const taskIds = pipeSection.match(/\b\d{3,}\b/g);
  if (taskIds?.length) {
    return { attempter: taskIds.length, reviewer: 0 };
  }

  return { attempter: 0, reviewer: 0 };
}

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
        Deliverable: { amount: 0, tasks: 0, attempter: 0, reviewer: 0, details: [] },
        currency,
      };
    }

    stats[date].Deliverable.amount += amount;
    const { attempter, reviewer } = extractTaskBreakdown(notes);
    stats[date].Deliverable.attempter += attempter;
    stats[date].Deliverable.reviewer += reviewer;
    stats[date].Deliverable.tasks += attempter + reviewer;
    if (notes) stats[date].Deliverable.details.push(notes.replaceAll('\n', '; '));
  }

  return stats;
}

export function importGreenlightCsv(content: string): {
  stats: Record<string, DayStats>;
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

  return { stats, rowsRead: rows.length, daysGenerated };
}
