import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';

/*
 * The page with the real route-view state, and only the data and the list faked:
 * the bug lived in how the page and `useRouteView` hand a pressed month between
 * them, which the main page test cannot see because it mocks that hook.
 */
const state = vi.hoisted(() => ({
  routes: [] as FareRoute[],
  projections: [] as { route: string | null; month: string | null }[],
  list: null as null | { onOpenMonth: (id: string, month: string) => void },
}));

vi.mock('@/features/airfare/hooks/useFareRoutes', () => ({
  useFareRoutes: () => ({
    routes: state.routes,
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
vi.mock('@/features/airfare/hooks/useFareProjections', () => ({
  useFareProjections: (route: FareRoute | null, month: string | null) => {
    state.projections.push({ route: route ? routeId(route) : null, month });
    return {
      primary: { data: undefined, isPending: false, error: null, refetch: vi.fn() },
      secondaryBoards: [],
    };
  },
}));
vi.mock('@/features/airfare/hooks/useRouteCollection', () => ({
  useRouteCollection: () => ({
    collecting: [],
    progress: new Map(),
    notices: [],
    collect: vi.fn(),
    forget: vi.fn(),
  }),
}));
vi.mock('@/features/airfare/hooks/useHorizonCollection', () => ({
  useHorizonCollection: () => ({ collecting: [], forget: vi.fn() }),
}));
vi.mock('@/features/airfare/hooks/useFareCalendar', () => ({
  useFareCalendar: () => ({ data: undefined, isPending: false, error: null }),
}));
vi.mock('@/features/airfare/hooks/useAirports', () => ({
  useAirports: () => ({ data: new Map() }),
}));
vi.mock('@/features/airfare/ui/RouteList', () => ({
  RouteList: (props: { onOpenMonth: (id: string, month: string) => void }) => {
    state.list = props;
    return <div data-testid="route-list" />;
  },
}));
vi.mock('@/features/airfare/ui/RouteMap', () => ({ RouteMap: () => <div /> }));
vi.mock('@/features/airfare/ui/RouteDetail', () => ({ RouteDetail: () => <div /> }));
vi.mock('@/features/airfare/ui/AnalysisPanel', () => ({
  ANALYSIS_PANEL_ID: 'analysis',
  AnalysisPanel: () => <div />,
}));
vi.mock('@/features/airfare/ui/FlightTable', () => ({ FlightTable: () => <div /> }));

import { AirfarePage } from './AirfarePage';

const ARI_SCL: FareRoute = {
  origin: 'ARI',
  destination: 'SCL',
  months: ['2027-03', '2027-04'],
  currency: 'USD',
};
const LIM_MAD: FareRoute = {
  origin: 'LIM',
  destination: 'MAD',
  months: ['2027-05', '2027-06', '2027-07'],
  currency: 'USD',
};

describe('pressing a month on another watched route', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-09-19T12:02:00.000Z'));
    state.routes = [ARI_SCL, LIM_MAD];
    state.projections = [];
    state.list = null;
  });

  it('opens that route on the month pressed, not on its first month', () => {
    render(<AirfarePage />);
    // The first route is open on its own first month.
    expect(state.projections.at(-1)).toEqual({ route: routeId(ARI_SCL), month: '2027-03' });

    act(() => state.list!.onOpenMonth(routeId(LIM_MAD), '2027-06'));

    expect(state.projections.at(-1)).toEqual({ route: routeId(LIM_MAD), month: '2027-06' });
  });

  it('leaves the route it came from on the month it was on', () => {
    render(<AirfarePage />);

    act(() => state.list!.onOpenMonth(routeId(LIM_MAD), '2027-06'));
    act(() => state.list!.onOpenMonth(routeId(ARI_SCL), '2027-03'));

    expect(state.projections.at(-1)).toEqual({ route: routeId(ARI_SCL), month: '2027-03' });
  });
});
