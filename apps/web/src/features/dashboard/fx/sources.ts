export const sources = [
  { id: 'kambista', name: 'Kambista', url: 'https://kambista.com/', reference: false },
  { id: 'tu-cambista', name: 'Tu Cambista', url: 'https://tucambista.pe/', reference: false },
  { id: 'securex', name: 'Securex', url: 'https://securex.pe/', reference: false },
  {
    id: 'cambio-seguro',
    name: 'Cambio Seguro',
    url: 'https://cambioseguro.com/',
    reference: false,
  },
  { id: 'dollarhouse', name: 'DollarHouse', url: 'https://dollarhouse.pe/', reference: false },
  { id: 'rextie', name: 'Rextie', url: 'https://www.rextie.com/', reference: false },
  { id: 'tkambio', name: 'TKambio', url: 'https://tkambio.com/', reference: false },
  {
    id: 'bcrp',
    name: 'BCRP interbank',
    url: 'https://estadisticas.bcrp.gob.pe/estadisticas/series/diarias/tipo-de-cambio',
    reference: true,
  },
  {
    id: 'sbs',
    name: 'SBS reference',
    url: 'https://estadisticas.bcrp.gob.pe/estadisticas/series/diarias/tipo-de-cambio',
    reference: true,
  },
] as const;
export type Source = (typeof sources)[number]['id'];
export const ranges = ['1D', '7D', '1M', '1Y', 'ALL'] as const;
export type Range = (typeof ranges)[number];
export function isSource(value: unknown): value is Source {
  return sources.some((source) => source.id === value);
}
export function isRange(value: unknown): value is Range {
  return ranges.some((range) => range === value);
}
export function isReference(source: Source) {
  return source === 'bcrp' || source === 'sbs';
}
