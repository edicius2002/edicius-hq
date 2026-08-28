import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { NO_PROJECTOR_VIEW, type ProjectorView } from '@/features/greenlight/lib/projectorView';
import { CompoundProjector } from '@/features/greenlight/ui/CompoundProjector';

/**
 * The section as a reader meets it.
 *
 * The figures below are the ones somebody can check by hand against Greenlight's
 * own net, and they are asserted as rendered strings rather than as numbers,
 * because the failure this guards against is not an arithmetic one — it is the
 * page printing a figure that disagrees with the headline above it.
 *
 * Table queries are scoped, because the chart between the two tables prints
 * money as well: its axis labels the balance the plot floors and tops out at,
 * and its readout names the month the crosshair rests on. A bare `getByText`
 * for a year-10 balance finds the axis too, which is the section agreeing with
 * itself rather than a query going wrong.
 *
 * The capital field reads a store of its own, so every render here is given one
 * that is already answered — seeded into the cache the way `FlowCanvas.test`
 * seeds the camera. These are tests about what the section prints, and none of
 * them should need an HTTP server to find that out; `useProjectorCapital.test`
 * is where the store's own timing is exercised.
 */

const NET = 20377.8;

const capitalField = () => screen.getByLabelText('Capital');
const rateField = () => screen.getByLabelText('Rate % a year');
const firstYearTable = () => within(screen.getAllByRole('table')[0]);
const byYearTable = () => within(screen.getAllByRole('table')[1]);

function storedWrapper(view: ProjectorView) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
      const next = new QueryClient({
        // `staleTime: Infinity` so the seeded answer is not immediately
        // refetched against the `fetch` that refuses to reach the network.
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity },
          mutations: { retry: false },
        },
      });
      next.setQueryData(['storage', 'greenlight-projector'], view);
      return next;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** Nothing remembered, which is what every test but the two about remembering assumes. */
function renderProjector(ui: ReactElement, view: ProjectorView = NO_PROJECTOR_VIEW) {
  return render(ui, { wrapper: storedWrapper(view) });
}

describe('the rate it is told about', () => {
  it('keeps the functional empty-state guidance without the redundant introduction', () => {
    renderProjector(<CompoundProjector capital={null} />);

    expect(screen.queryByText(/Interest paid every month and left where it lands/i)).toBeNull();
    expect(screen.getByText(/Type a capital above/i)).toBeInTheDocument();
  });

  it('says what 6% a year paid monthly is a month, and what it is really worth a year', () => {
    renderProjector(<CompoundProjector capital={NET} />);
    expect(rateField()).toHaveValue('6');
    // 0.500 and not 0.4868: the annual rate divided by twelve, which is why the
    // year comes out above 6% rather than exactly on it.
    expect(screen.getByText('0.500%')).toBeInTheDocument();
    expect(screen.getByText('6.1678%')).toBeInTheDocument();
  });

  it('follows the rate into every figure when it is retyped', () => {
    renderProjector(<CompoundProjector capital={1000} />);
    fireEvent.change(rateField(), { target: { value: '12' } });
    expect(screen.getByText('1.000%')).toBeInTheDocument();
    expect(screen.getByText('12.6825%')).toBeInTheDocument();
    // A month of 1% on $1,000.
    expect(firstYearTable().getByText('$10.00')).toBeInTheDocument();
  });
});

describe('the first year', () => {
  it('earns $101.89 in month 1 and closes the year at $21,634.66', () => {
    renderProjector(<CompoundProjector capital={NET} />);
    const table = firstYearTable();
    expect(table.getByText('$101.89')).toBeInTheDocument();
    expect(table.getByText('$20,479.69')).toBeInTheDocument();
    // Month 2 earns more than month 1, because month 1's interest was left in.
    expect(table.getByText('$102.40')).toBeInTheDocument();
    expect(table.getByText('$20,582.09')).toBeInTheDocument();
    expect(table.getByText('$107.64')).toBeInTheDocument();
  });

  it('shows twelve months and no more', () => {
    renderProjector(<CompoundProjector capital={NET} />);
    // Header, twelve months, and the footer that totals them.
    expect(firstYearTable().getAllByRole('row')).toHaveLength(14);
  });

  it('foots the year at $1,256.86, which is more than 6% of the capital', () => {
    renderProjector(<CompoundProjector capital={NET} />);
    expect(screen.getByText('Year 1 interest')).toBeInTheDocument();
    expect(firstYearTable().getByText('$1,256.86')).toBeInTheDocument();
    // 6% of $20,377.80 is $1,222.67, and the difference is the whole subject.
    expect(screen.queryByText('$1,222.67')).toBeNull();
  });
});

describe('by year', () => {
  it('names 1, 2, 3, 5 and 10 and no others', () => {
    renderProjector(<CompoundProjector capital={NET} />);
    const rows = byYearTable().getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual([
      '1',
      '2',
      '3',
      '5',
      '10',
    ]);
  });

  it('reaches $37,075.30 at ten years, having earned $16,697.50', () => {
    renderProjector(<CompoundProjector capital={NET} />);
    const table = byYearTable();
    expect(table.getByText('$37,075.30')).toBeInTheDocument();
    expect(table.getByText('+$16,697.50')).toBeInTheDocument();
    expect(table.getByText('$27,486.60')).toBeInTheDocument();
    expect(table.getByText('+$7,108.80')).toBeInTheDocument();
  });

  it('prints year 1 from the same month the first table ends on', () => {
    renderProjector(<CompoundProjector capital={NET} />);
    // Once as month 12's balance, once as year 1 — two printings of one row
    // rather than two computations that could drift apart.
    expect(firstYearTable().getByText('$21,634.66')).toBeInTheDocument();
    expect(byYearTable().getByText('$21,634.66')).toBeInTheDocument();
  });
});

describe('the capital', () => {
  it('starts on the net the page was handed, to the cent', () => {
    renderProjector(<CompoundProjector capital={NET} />);
    // 20,377.80 and not 20,338.80 — the flat-10% figure, which is $39 out
    // because the fee is charged per marker period and small periods are exempt.
    expect(capitalField()).toHaveValue('20377,8');
    expect(firstYearTable().getByText('$101.89')).toBeInTheDocument();
  });

  it('rounds the float the net actually is, so the field agrees with the Stat', () => {
    // What `computeSegmentedTotals` really hands over, measured in the running
    // app. Every formatter on the page hides the tail; a text field does not.
    renderProjector(<CompoundProjector capital={20377.803000000004} />);
    expect(capitalField()).toHaveValue('20377,8');
  });

  it('opens on the capital it was left on last time, in place of the page net', () => {
    renderProjector(<CompoundProjector capital={NET} />, { version: 1, capital: '1000' });
    expect(capitalField()).toHaveValue('1000');
    // And the whole section is projected from it, not just the field: 0.5% of
    // $1,000 rather than the $101.89 the page's own net would have earned.
    expect(firstYearTable().getByText('$5.00')).toBeInTheDocument();
  });

  it('keeps a remembered capital when a later net arrives, and gives it up when the field is cleared', () => {
    const view = renderProjector(<CompoundProjector capital={null} />, {
      version: 1,
      capital: '1000',
    });
    // A fresh CSV moves the page's net. The reader's capital is still theirs.
    view.rerender(<CompoundProjector capital={NET} />);
    expect(capitalField()).toHaveValue('1000');

    // Emptying it is the way back, and it does not refill under the cursor.
    fireEvent.change(capitalField(), { target: { value: '' } });
    expect(capitalField()).toHaveValue('');
    expect(screen.getByText(/Nothing compounds from zero/)).toBeInTheDocument();
  });

  it('follows the page until somebody types, and stops following once they have', () => {
    const view = renderProjector(<CompoundProjector capital={null} />);
    expect(capitalField()).toHaveValue('');

    // The document finished loading.
    view.rerender(<CompoundProjector capital={NET} />);
    expect(capitalField()).toHaveValue('20377,8');

    fireEvent.change(capitalField(), { target: { value: '1000' } });
    expect(firstYearTable().getByText('$5.00')).toBeInTheDocument();

    // A later net does not overwrite what the reader put there.
    view.rerender(<CompoundProjector capital={30000} />);
    expect(capitalField()).toHaveValue('1000');
  });

  it('projects nothing at all from an empty, zero or negative capital', () => {
    renderProjector(<CompoundProjector capital={null} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/Nothing compounds from zero/)).toBeInTheDocument();

    fireEvent.change(capitalField(), { target: { value: '-5000' } });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/Nothing compounds from zero/)).toBeInTheDocument();

    fireEvent.change(capitalField(), { target: { value: '0' } });
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('reads a comma decimal, which is what this app writes into a money field', () => {
    renderProjector(<CompoundProjector capital={null} />);
    fireEvent.change(capitalField(), { target: { value: '2000,50' } });
    const table = firstYearTable();
    // 0.5% of 2,000.50.
    expect(table.getByText('$10.00')).toBeInTheDocument();
    expect(table.getByText('$2,010.50')).toBeInTheDocument();
  });
});

describe('the currency it is told to use', () => {
  it('writes the currency the page is keeping rather than assuming dollars', () => {
    renderProjector(<CompoundProjector capital={1000} currency="EUR" />);
    expect(firstYearTable().getByText('€5.00')).toBeInTheDocument();
  });
});
