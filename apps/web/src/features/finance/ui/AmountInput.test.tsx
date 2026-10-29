import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { AmountInput } from './AmountInput';

afterEach(cleanup);

it('limits the visible draft and emitted amount to two decimal places', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<AmountInput aria-label="Amount" value={0} onChange={onChange} />);

  const input = screen.getByRole('textbox', { name: 'Amount' });
  await user.clear(input);
  await user.type(input, '1,234');

  expect(input).toHaveValue('1,23');
  expect(onChange).toHaveBeenLastCalledWith(1.23);
  await user.tab();
  expect(input).toHaveValue('0');
});
