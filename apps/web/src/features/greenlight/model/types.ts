export type DeliverableBucket = {
  amount: number;
  tasks: number;
  attempter: number;
  reviewer: number;
  details: string[];
};

export type DayStats = {
  Deliverable: DeliverableBucket;
  currency: string;
};

export type GreenlightMeta = {
  fileName: string;
  rowsRead: number;
  daysGenerated: number;
  updatedAt: string;
};

export type GreenlightState = {
  stats: Record<string, DayStats>;
  meta: GreenlightMeta | null;
};

export type WeekPoint = {
  key: string;
  label: string;
  amount: number;
  tasks: number;
  currency: string;
};

export type MonthGroup = {
  key: string;
  label: string;
  amount: number;
  tasks: number;
  weeks: WeekPoint[];
};

export const EMPTY_GREENLIGHT_STATE: GreenlightState = {
  stats: {},
  meta: null,
};
