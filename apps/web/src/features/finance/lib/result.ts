/**
 * A value or a typed failure. Operations that can legitimately be refused return
 * this instead of silently doing nothing, so the caller has to handle the refusal
 * and the reason can be shown and tested.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
