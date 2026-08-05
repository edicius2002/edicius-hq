function normalizeHeader(header: string): string {
  return header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase();
}

function splitCsvRecords(content: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      record.push(current.trim());
      current = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      record.push(current.trim());
      records.push(record);
      record = [];
      current = '';
    } else {
      current += char;
    }
  }

  if (current || record.length) {
    record.push(current.trim());
    records.push(record);
  }

  return records;
}

export type CsvRow = Record<string, string>;

export function parseCsv(content: string): CsvRow[] {
  const records = splitCsvRecords(content).filter((record) => record.some((value) => value.trim()));
  if (records.length < 2) return [];

  const headers = records[0].map(normalizeHeader);
  return records
    .slice(1)
    .map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])),
    );
}

export function valueFor(row: CsvRow, keys: string[]): string {
  for (const key of keys) {
    if (row[key]) return String(row[key]).trim();
  }
  return '';
}
