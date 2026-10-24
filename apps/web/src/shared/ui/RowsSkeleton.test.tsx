import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import { RowsSkeleton } from './RowsSkeleton';

it('announces one loading region and hides decorative rows', () => {
  const { container } = render(<RowsSkeleton label="Loading watchlist" rows={4} />);
  expect(screen.getByRole('status', { name: 'Loading watchlist' })).toBeInTheDocument();
  expect(container.querySelectorAll('[data-testid="skeleton-row"]')).toHaveLength(4);
  expect(container.querySelector('button, input, a')).toBeNull();
});
