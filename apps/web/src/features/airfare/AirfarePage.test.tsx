import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  worker: null as null | { status: string; started_at: string; heartbeat_at: string },
  collect: vi.fn(),
}));

vi.mock('@/features/airfare/data/collectorStatus', () => ({
  airfaresStatusText: () => 'Scheduled Airfare status remains visible.',
  useAirfareCollectorStatus: () => ({ data: null, isError: false }),
  useAirfareRequestWorkerStatus: () => ({ data: state.worker, isError: false }),
  airfareRequestWorkerHealthy: (
    run: null | { status: string; started_at: string; heartbeat_at: string },
  ) => {
    if (!run || run.status !== 'running') return false;
    const started = Date.parse(run.started_at);
    const heartbeat = Date.parse(run.heartbeat_at);
    return heartbeat > started && Date.now() - heartbeat <= 90_000;
  },
}));

vi.mock('@/features/airfare/hooks/useRouteCollection', () => ({
  useRouteCollection: () => ({
    collecting: [],
    progress: new Map(),
    notices: [],
    collect: state.collect,
    forget: vi.fn(),
  }),
}));
vi.mock('@/features/airfare/hooks/useFareRoutes', () => ({
  useFareRoutes: () => ({
    routes: [],
    isFetching: false,
    isError: false,
    saveState: 'saved',
    retrySave: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
    update: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock('@/features/airfare/hooks/useHorizonCollection', () => ({
  useHorizonCollection: () => ({ collecting: [], forget: vi.fn() }),
}));
vi.mock('@/features/airfare/hooks/useFareHistory', () => ({
  useFareHistory: () => ({ data: undefined, isPending: false, error: null, refetch: vi.fn() }),
}));
vi.mock('@/features/airfare/hooks/useFareCalendar', () => ({
  useFareCalendar: () => ({ data: undefined, isPending: false, error: null }),
}));
vi.mock('@/features/airfare/hooks/useAirports', () => ({
  useAirports: () => ({ data: new Map() }),
}));
vi.mock('@/features/airfare/hooks/useRouteView', () => ({
  useRouteView: () => ({
    view: { month: null, granularity: 'month', anchor: null, viewport: null },
    setMonth: vi.fn(),
    openOn: vi.fn(),
    setGranularity: vi.fn(),
    setAnchor: vi.fn(),
    setViewport: vi.fn(),
  }),
}));

vi.mock('@/features/airfare/ui/RouteList', () => ({
  RouteList: ({ onCollect }: { onCollect?: unknown }) => (
    <div data-testid="route-list" data-can-collect={onCollect ? 'yes' : 'no'} />
  ),
}));
vi.mock('@/features/airfare/ui/RouteMap', () => ({
  RouteMap: () => <div />,
}));
vi.mock('@/features/airfare/ui/RouteDetail', () => ({
  RouteDetail: () => <div />,
}));
vi.mock('@/features/airfare/ui/AnalysisPanel', () => ({
  ANALYSIS_PANEL_ID: 'analysis',
  AnalysisPanel: () => <div />,
}));
vi.mock('@/features/airfare/ui/FlightTable', () => ({
  FlightTable: () => <div />,
}));

import { AirfarePage } from './AirfarePage';

describe('AirfarePage manual collection availability', () => {
  beforeEach(() => {
    state.worker = null;
    vi.setSystemTime(new Date('2026-09-19T12:02:00.000Z'));
  });

  it('withholds collection unless the Pi request worker heartbeat is fresh', () => {
    const view = render(<AirfarePage />);
    expect(screen.getByTestId('route-list')).toHaveAttribute('data-can-collect', 'no');

    state.worker = {
      status: 'running',
      started_at: '2026-09-19T12:00:00.000Z',
      heartbeat_at: '2026-09-19T12:01:00.000Z',
    };
    view.rerender(<AirfarePage />);
    expect(screen.getByTestId('route-list')).toHaveAttribute('data-can-collect', 'yes');
  });

  it('keeps the scheduled collector status separate and visible', () => {
    render(<AirfarePage />);
    expect(screen.getByTestId('airfare-collector-status')).toHaveTextContent(
      'Scheduled Airfare status remains visible.',
    );
  });
});
