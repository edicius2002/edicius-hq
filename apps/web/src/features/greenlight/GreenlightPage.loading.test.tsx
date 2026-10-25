import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';

import { EMPTY_GREENLIGHT_STATE } from './model/types';

vi.mock('./hooks/useGreenlightData', () => ({
  useGreenlightData: () => ({
    state: EMPTY_GREENLIGHT_STATE,
    isFetching: true,
    isError: false,
    saveState: 'loading',
  }),
}));

import { GreenlightPage } from './GreenlightPage';

it('shows the Greenlight layout while its first document is pending', () => {
  render(<GreenlightPage />, { wrapper: queryWrapper() });
  expect(screen.getByRole('status', { name: 'Loading greenlight' })).toBeInTheDocument();
  expect(screen.getByText('No weeks to show.')).not.toBeVisible();
});
