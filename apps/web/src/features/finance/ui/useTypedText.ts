import { useState } from 'react';

/** What a text field needs to be driven by what is being typed into it. */
export type TypedText = {
  value: string;
  onChange: (next: string) => void;
  onBlur: () => void;
};

/**
 * Hold what is being typed in the field itself, and tell the document after.
 *
 * Every edit in Finance reaches storage through `useStoredDocument`, which runs
 * it on a promise chain so that two edits started together cannot each build on
 * pre-write state. That serialisation is the point, but it means the new value
 * comes back a microtask *after* the keystroke that caused it — and a
 * controlled field whose value arrives that late cannot keep its caret. React
 * restores the box to the value it last rendered when an event ends without a
 * re-render, then the late value lands and is assigned to the element, which
 * drops the caret at the end. Typing anywhere but the end was therefore
 * impossible: the first letter went in where you put it and the rest piled up
 * at the end behind it.
 *
 * So the field leads and the document follows, and the draft is dropped on blur
 * so the field goes back to showing what is stored. It is the arrangement
 * `AmountInput` already uses to keep a half-written number under the cursor.
 *
 * Nothing else edits the diagram while a field has focus — the undo shortcut in
 * `FinancePage` stands down for anything typed into a field, precisely so it
 * does not take the one a field has of its own — so a draft cannot mask a
 * change made elsewhere.
 */
export function useTypedText(value: string, onChange: (next: string) => void): TypedText {
  const [draft, setDraft] = useState<string | null>(null);

  return {
    value: draft ?? value,
    onChange: (next) => {
      setDraft(next);
      onChange(next);
    },
    onBlur: () => setDraft(null),
  };
}
