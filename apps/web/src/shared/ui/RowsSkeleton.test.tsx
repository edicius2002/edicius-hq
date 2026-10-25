import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import { RowsSkeleton } from './RowsSkeleton';

it('announces one loading region and hides decorative rows', () => {
  const { container } = render(
    <RowsSkeleton label="Loading watchlist" variant="watchlist" rows={4} />,
  );
  expect(screen.getByRole('status', { name: 'Loading watchlist' })).toBeInTheDocument();
  expect(container.querySelectorAll('[data-testid="skeleton-row"]')).toHaveLength(4);
  expect(container.querySelector('button, input, a')).toBeNull();
});

it.each([
  ['watchlist', 3],
  ['positions', 4],
  ['alerts', 3],
] as const)('uses the %s row structure', (variant, cells) => {
  const { container } = render(
    <RowsSkeleton label={`Loading ${variant}`} variant={variant} rows={2} />,
  );
  const rows = container.querySelectorAll('[data-testid="skeleton-row"]');

  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row.querySelectorAll('[data-skeleton-cell]')).toHaveLength(cells);
  expect(container.querySelector('[data-skeleton-shape]')).toHaveAttribute(
    'data-skeleton-shape',
    variant,
  );
});
