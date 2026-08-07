import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SaveStatus } from '@/shared/ui/SaveStatus';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SaveStatus', () => {
  it('says that edits are being held before it says they are saved', () => {
    const { rerender } = render(<SaveStatus state="pending" />);
    expect(screen.getByRole('status')).toHaveTextContent('Pending…');

    rerender(<SaveStatus state="saving" />);
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');

    rerender(<SaveStatus state="saved" />);
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('lets "Saved" fade back to idle instead of sitting there', () => {
    vi.useFakeTimers();
    render(<SaveStatus state="saved" />);

    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'saved');
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'idle');
  });

  it('offers a retry when a write failed', async () => {
    const onRetry = vi.fn();
    render(<SaveStatus state="failed" onRetry={onRetry} />);

    expect(screen.getByRole('status')).toHaveTextContent('Save failed');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('asks for a reload rather than a retry when the read is what failed', () => {
    render(<SaveStatus state="blocked" onRetry={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Reload to save');
    // Retrying a write that is refused would only fail again.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
