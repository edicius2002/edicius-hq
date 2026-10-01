import type { Source, Range } from './sources';
export type Observation = {
  owner_id: string;
  source: Source;
  observed_at: string;
  effective_at: string;
  buy: number;
  sell: number;
  context: Record<string, unknown>;
};
export type History = { points: Observation[]; aggregation: 'daily' | 'observations' };
export type Preferences = { source: Source; range: Range; favorites: Source[] };
