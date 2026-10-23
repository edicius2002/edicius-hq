export function parseExclusionKeys(source: string): string[] {
  const data: unknown = JSON.parse(source);
  if (!Array.isArray(data)) throw new Error('The JSON must contain a list of exclusion keys.');

  const keys = new Set<string>();
  for (const value of data) {
    if (typeof value !== 'string' || value.length > 500) {
      throw new Error('The JSON contains an invalid exclusion key.');
    }
    const prefix = value.startsWith('minor:')
      ? 'minor:'
      : value.startsWith('process:')
        ? 'process:'
        : null;
    if (!prefix) throw new Error('The JSON contains an invalid exclusion key.');
    let parts: unknown;
    try {
      parts = JSON.parse(value.slice(prefix.length));
    } catch {
      throw new Error('The JSON contains an invalid exclusion key.');
    }
    const expected = prefix === 'minor:' ? 2 : 4;
    if (
      !Array.isArray(parts) ||
      parts.length !== expected ||
      !parts.every((part) => typeof part === 'string')
    ) {
      throw new Error('The JSON contains an invalid exclusion key.');
    }
    keys.add(value);
  }
  return [...keys];
}
