import { type InputHTMLAttributes } from 'react';

import { useTypedText } from '@/features/finance/ui/useTypedText';

type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onChange: (value: string) => void;
};

/**
 * A single line of text over the finance document.
 *
 * The same field an `<input>` would be, except that what you type stays under
 * the cursor while you are typing it. See `useTypedText` for why a plain
 * controlled input cannot: the document answers a microtask late, and a caret
 * does not survive the wait.
 */
export function TextInput({ value, onChange, onBlur, ...rest }: TextInputProps) {
  const typed = useTypedText(value, onChange);

  return (
    <input
      {...rest}
      value={typed.value}
      onChange={(event) => typed.onChange(event.target.value)}
      onBlur={(event) => {
        typed.onBlur();
        onBlur?.(event);
      }}
    />
  );
}
