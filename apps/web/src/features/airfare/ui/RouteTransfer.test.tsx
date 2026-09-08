import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RouteTransfer } from '@/features/airfare/ui/RouteTransfer';
import { clearToken, writeToken } from '@/shared/auth/session';

describe('RouteTransfer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearToken();
  });

  it('downloads the authenticated gzip export with the server filename', async () => {
    const user = userEvent.setup();
    writeToken('airfare-session');
    const fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x1f, 0x8b]), {
          headers: {
            'Content-Type': 'application/gzip',
            'Content-Disposition': 'attachment; filename="airfare-watch-2026-09-08.json.gz"',
          },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:airfare-export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    let download = '';
    let href = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      download = this.download;
      href = this.href;
    });
    render(<RouteTransfer disabled={false} onImported={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/api/fares/watch/export');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer airfare-session');
    expect(createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ size: 2, type: 'application/gzip' }),
    );
    expect(download).toBe('airfare-watch-2026-09-08.json.gz');
    expect(href).toBe('blob:airfare-export');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:airfare-export');
  });

  it('posts the selected watch export and says how every imported row was handled', async () => {
    const user = userEvent.setup();
    writeToken('airfare-session');
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

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/api/fares/watch/import');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer airfare-session');
    expect(init.body).toBeInstanceOf(FormData);
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
