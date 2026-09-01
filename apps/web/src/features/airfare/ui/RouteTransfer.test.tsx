import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RouteTransfer } from '@/features/airfare/ui/RouteTransfer';

describe('RouteTransfer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the selected watch export and says how every imported row was handled', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(async () =>
      Response.json({
        routesAdded: 1,
        routesUpdated: 2,
        observationsImported: 3,
        observationsSkipped: 4,
        invalidRows: 5,
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const onImported = vi.fn();
    render(<RouteTransfer disabled={false} onImported={onImported} />);

    await user.upload(
      screen.getByLabelText('Airfare watch file'),
      new File(['watch export'], 'airfare-watch.json.gz', { type: 'application/gzip' }),
    );

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/fares/watch/import',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      '1 routes added, 2 updated; 3 observations imported, 4 skipped; 5 invalid rows discarded.',
    );
    expect(onImported).toHaveBeenCalledOnce();
  });

  it('keeps the controls in one shared row and reports a rejected import', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: 'Invalid watch transfer file' }, { status: 400 })),
    );
    render(<RouteTransfer disabled={false} onImported={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
    await user.upload(screen.getByLabelText('Airfare watch file'), new File(['bad'], 'bad.json'));

    expect(await screen.findByRole('status')).toHaveTextContent('Invalid watch transfer file');
  });
});
