import { valueFor, type CsvRow } from '@/features/greenlight/lib/csv';
import type { ToolId, ToolWidgets } from '@/features/greenlight/model/types';

/** Monthly reimbursement billed per tool, taken from the TimeRecords Expense rows. */
export const TOOL_RATES: Record<ToolId, number> = {
  vscode: 10,
  cursor: 20,
};

export const TOOL_LABELS: Record<ToolId, string> = {
  vscode: 'VSCode',
  cursor: 'Cursor',
};

export const TOOL_IDS: ToolId[] = ['vscode', 'cursor'];

const TOOL_PATTERNS: { tool: ToolId; pattern: RegExp }[] = [
  { tool: 'vscode', pattern: /vs\s?code|copilot/i },
  { tool: 'cursor', pattern: /cursor/i },
];

function sortTools(tools: Iterable<ToolId>): ToolId[] {
  return TOOL_IDS.filter((tool) => [...tools].includes(tool));
}

/**
 * Read tool reimbursements out of the Expense rows of a TimeRecords export.
 * Deliverable rows are ignored here — they are the paid work, handled by processRows.
 */
export function detectToolWidgets(rows: CsvRow[]): ToolWidgets {
  const byMonth = new Map<string, Set<ToolId>>();

  for (const row of rows) {
    const date = valueFor(row, ['date/start', 'date', 'fecha', 'start']).split('T')[0];
    const recordType = valueFor(row, ['record type', 'tipo', 'type']).toLowerCase();
    const notes = valueFor(row, ['notes', 'notas', 'descripcion', 'description']);

    if (!date || !recordType) continue;
    if (!recordType.includes('expense') && !recordType.includes('gasto')) continue;

    const monthKey = date.slice(0, 7);
    if (monthKey.length !== 7) continue;

    for (const { tool, pattern } of TOOL_PATTERNS) {
      if (!pattern.test(notes)) continue;
      const current = byMonth.get(monthKey) ?? new Set<ToolId>();
      current.add(tool);
      byMonth.set(monthKey, current);
    }
  }

  const widgets: ToolWidgets = {};
  for (const [monthKey, tools] of byMonth) {
    widgets[monthKey] = sortTools(tools);
  }
  return widgets;
}

/**
 * Seed detected widgets without ever overwriting a month the user already touched.
 * A month stored as an empty array counts as touched, so a manual removal survives re-import.
 */
export function mergeDetectedWidgets(existing: ToolWidgets, detected: ToolWidgets): ToolWidgets {
  const merged: ToolWidgets = { ...existing };
  for (const [monthKey, tools] of Object.entries(detected)) {
    if (monthKey in merged) continue;
    merged[monthKey] = tools;
  }
  return merged;
}

/** Toggle one tool for one month. Keeps an empty array behind so the month stays touched. */
export function toggleToolWidget(
  widgets: ToolWidgets,
  monthKey: string,
  tool: ToolId,
): ToolWidgets {
  const current = widgets[monthKey] ?? [];
  const next = current.includes(tool)
    ? current.filter((item) => item !== tool)
    : sortTools([...current, tool]);
  return { ...widgets, [monthKey]: next };
}

export function normalizeToolWidgets(value: unknown): ToolWidgets {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const widgets: ToolWidgets = {};
  for (const [monthKey, tools] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(tools)) continue;
    widgets[monthKey] = sortTools(
      tools.filter((tool): tool is ToolId => TOOL_IDS.includes(tool as ToolId)),
    );
  }
  return widgets;
}
