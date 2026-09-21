import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  collect: vi.fn(),
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
    vi.setSystemTime(new Date('2026-09-19T12:02:00.000Z'));
  });

  it('offers the circular manual collection controls from the first render', () => {
    render(<AirfarePage />);
    expect(screen.getByTestId('route-list')).toHaveAttribute('data-can-collect', 'yes');
  });

  it('omits the scheduled collector status', () => {
    render(<AirfarePage />);
    expect(screen.queryByTestId('airfare-collector-status')).not.toBeInTheDocument();
  });
});
