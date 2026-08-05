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

export type ReplaceMode = 'all' | 'current-month';

export type GreenlightMeta = {
  fileName: string;
  rowsRead: number;
  daysGenerated: number;
  replaceMode?: ReplaceMode;
  updatedAt: string;
  statusTitle?: string;
  statusDetail?: string;
};

export type GreenlightState = {
  stats: Record<string, DayStats>;
  meta: GreenlightMeta | null;
  markers: string[];
};

export type WeekPoint = {
  key: string;
  label: string;
  startLabel: string;
  endLabel: string;
  amount: number;
  tasks: number;
  currency: string;
};

export type MonthPoint = {
  key: string;
  label: string;
  amount: number;
  currency: string;
};

export type MonthGroup = {
  key: string;
  label: string;
  amount: number;
  tasks: number;
  currency: string;
  weeks: WeekPoint[];
};

export type SegmentSummaryItem = {
  rangeLabel: string;
  dayCount: number;
  closed: boolean;
  amount: number;
  fee: number;
  net: number;
  tasks: number;
  currency: string;
};

export const EMPTY_GREENLIGHT_STATE: GreenlightState = {
  stats: {},
  meta: null,
  markers: [],
};

export const MARKER_SEGMENT_STYLES = [
  { background: 'rgba(214,166,93,0.10)', border: 'rgba(214,166,93,0.48)', color: '#e3b96f' },
  { background: 'rgba(96,165,250,0.10)', border: 'rgba(96,165,250,0.48)', color: '#8fbeff' },
  { background: 'rgba(74,222,128,0.09)', border: 'rgba(74,222,128,0.44)', color: '#75e49b' },
  { background: 'rgba(196,181,253,0.10)', border: 'rgba(196,181,253,0.46)', color: '#d0c4ff' },
] as const;
