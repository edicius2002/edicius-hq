import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  collect: vi.fn(),
  notices: [] as {
    id: string;
    routeId: string;
    monthKey: string;
    title: string;
    text: string;
    kind: 'success';
  }[],
}));

vi.mock('@/features/airfare/hooks/useRouteCollection', () => ({
  useRouteCollection: () => ({
    collecting: [],
    progress: new Map(),
    notices: state.notices,
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
vi.mock('@/features/airfare/hooks/useFareProjections', () => ({
  useFareProjections: () => ({
    primary: { data: undefined, isPending: false, error: null, refetch: vi.fn() },
    secondaryBoards: [],
  }),
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
    openMonthOf: vi.fn(),
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
    state.notices = [];
  });

  it('offers the circular manual collection controls from the first render', () => {
    render(<AirfarePage />);
    expect(screen.getByTestId('route-list')).toHaveAttribute('data-can-collect', 'yes');
  });

  it('omits the scheduled collector status', () => {
    render(<AirfarePage />);
    expect(screen.queryByTestId('airfare-collector-status')).not.toBeInTheDocument();
  });

  it('announces collection results without showing a popup', () => {
    state.notices = [
      {
        id: 'request-1',
        routeId: 'LIM|CUZ',
        monthKey: 'LIM|CUZ|2026-10',
        title: 'LIM → CUZ · October 2026',
        text: 'Collection complete: 2 departures checked, 1 updated.',
        kind: 'success',
      },
    ];
    render(<AirfarePage />);
    expect(screen.queryByTestId('collect-notices')).not.toBeInTheDocument();
    expect(screen.getByTestId('collect-announcements')).toContainElement(
      screen.getByRole('status'),
    );
    expect(screen.getByRole('status')).toHaveTextContent('1 updated');
  });
});
