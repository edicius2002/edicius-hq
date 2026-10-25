import { act, fireEvent, render, screen } from '@testing-library/react';
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
  collecting: [] as string[],
  flowLegs: new Map<string, string>(),
  list: null as null | {
    selectedId: string | null;
    editing: FareRoute | null;
    onOpenMonth: (id: string, month: string) => void;
  },
}));

vi.mock('@/features/airfare/lib/geo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/airfare/lib/geo')>();
  return {
    ...actual,
    routeGeometries: (...args: Parameters<typeof actual.routeGeometries>) => {
      state.flowLegs = new Map(args[2]);
      return actual.routeGeometries(...args);
    },
  };
});
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
    collecting: state.collecting,
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
  RouteList: (props: {
    selectedId: string | null;
    editing: FareRoute | null;
    onOpenMonth: (id: string, month: string) => void;
  }) => {
    state.list = props;
    return <div data-testid="route-list" />;
  },
}));
vi.mock('@/features/airfare/ui/RouteMap', () => ({
  RouteMap: ({ onSelect }: { onSelect: (id: string | null) => void }) => (
    <div
      data-airfare-map
      data-testid="map-stage"
      role="application"
      onPointerUp={(event) => onSelect((event.target as Element).getAttribute('data-route'))}
    >
      <span data-route="ARI|SCL">Map arc</span>
      <span data-route="LIM|MAD">Other map arc</span>
    </div>
  ),
}));
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
    state.collecting = [];
    state.flowLegs = new Map();
    state.list = null;
  });

  it('starts without an open route and opens the month pressed', () => {
    render(<AirfarePage />);
    expect(state.list?.selectedId).toBeNull();
    expect(state.projections.at(-1)).toEqual({ route: null, month: null });

    act(() => state.list!.onOpenMonth(routeId(LIM_MAD), '2027-06'));

    expect(state.projections.at(-1)).toEqual({ route: routeId(LIM_MAD), month: '2027-06' });
  });

  it('closes the route and month when clicking empty space outside the list', () => {
    render(<AirfarePage />);
    act(() => state.list!.onOpenMonth(routeId(LIM_MAD), '2027-06'));

    fireEvent.click(screen.getByRole('heading', { name: 'Flight details' }));

    expect(state.list?.selectedId).toBeNull();
    expect(state.projections.at(-1)).toEqual({ route: null, month: null });
  });

  it('keeps a route selected from the map after its native click and clears it on empty map space', () => {
    render(<AirfarePage />);
    const stage = screen.getByTestId('map-stage');

    fireEvent.pointerUp(screen.getByText('Map arc'));
    fireEvent.click(stage);
    expect(state.list?.selectedId).toBe(routeId(ARI_SCL));

    fireEvent.pointerUp(stage);
    fireEvent.click(stage);
    expect(state.list?.selectedId).toBeNull();
  });

  it('switches the editor with the map selection and clears it when deselected', () => {
    render(<AirfarePage />);
    const stage = screen.getByTestId('map-stage');

    fireEvent.pointerUp(screen.getByText('Map arc'));
    expect(state.list?.editing).toEqual(ARI_SCL);
    expect(screen.queryByRole('button', { name: /Cancel editing/ })).not.toBeInTheDocument();

    fireEvent.pointerUp(screen.getByText('Other map arc'));
    expect(state.list?.editing).toEqual(LIM_MAD);

    fireEvent.pointerUp(stage);
    expect(state.list?.editing).toBeNull();
  });

  it('points the map toward a route after its monthly fetch finishes', () => {
    const page = render(<AirfarePage />);

    state.collecting = ['ARI|SCL|2027-03'];
    page.rerender(<AirfarePage />);
    state.collecting = [];
    page.rerender(<AirfarePage />);

    expect(state.flowLegs.get('ARI~SCL')).toBe('ARI>SCL');
  });

  it('leaves the route it came from on the month it was on', () => {
    render(<AirfarePage />);

    act(() => state.list!.onOpenMonth(routeId(LIM_MAD), '2027-06'));
    act(() => state.list!.onOpenMonth(routeId(ARI_SCL), '2027-03'));

    expect(state.projections.at(-1)).toEqual({ route: routeId(ARI_SCL), month: '2027-03' });
  });
});
