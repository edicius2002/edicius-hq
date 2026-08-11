import { useState, type InputHTMLAttributes } from 'react';

import { amountToInput, parseAmount } from '@/shared/lib/money';

type AmountInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'inputMode'
> & {
  value: number | null;
  onChange: (value: number | null) => void;
};

/**
 * A field for an amount, written with the comma the rest of the app uses.
 *
 * **Deliberately not `type="number"`.** A native number field renders its value
 * with the browser UI's decimal separator, which cannot be overridden — so the
 * same balance read `3250,00` on a node and `3250.00` in the field that edits
 * it, and the point you typed stayed a point. It also refuses
 * `setSelectionRange`, so there is no way to fix that from the outside either.
 *
 * A typed point becomes a comma, which is the whole request: on a numeric
 * keypad the point is the only separator there is, and it should mean what the
 * screen means by it.
 *
 * What you are typing is held here while the field has focus, so a half-written
 * `12,` survives until you finish it — parsed and handed back as the last valid
 * number, but not rewritten under the cursor. On blur the draft is dropped and
 * the field goes back to showing the stored value.
 */
export function AmountInput({ value, onChange, ...rest }: AmountInputProps) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <input
      {...rest}
      type="text"
      // The numeric keypad on a phone, without the spinner and the locale
      // rendering that come with `type="number"`.
      inputMode="decimal"
      value={draft ?? amountToInput(value)}
      onChange={(event) => {
        const next = event.target.value.replace(/\./g, ',');
        setDraft(next);
        onChange(parseAmount(next));
      }}
      onBlur={(event) => {
        setDraft(null);
        rest.onBlur?.(event);
      }}
    />
  );
}
