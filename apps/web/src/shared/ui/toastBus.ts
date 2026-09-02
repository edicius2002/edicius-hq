/**
 * Toasts, pushed from anywhere.
 *
 * A module-level singleton with `push`/`subscribe`, the same shape
 * `data/quoteBus.ts` already uses (`export const quoteBus = new QuoteBus()`)
 * — so code with no view of `<ToastHost />`'s component tree, such as an
 * alert evaluator mounted above the router, can still show one.
 */

export type ToastTone = 'buy' | 'sell' | 'neutral';

export type Toast = { id: string; message: string; tone: ToastTone };

type Listener = (toasts: Toast[]) => void;

class ToastBus {
  private toasts: Toast[] = [];
  private readonly listeners = new Set<Listener>();

  /** Stacks rather than replacing — several alerts firing together must not stomp on each other. */
  push(toast: { message: string; tone?: ToastTone }): string {
    const id = crypto.randomUUID();
    this.toasts = [...this.toasts, { id, message: toast.message, tone: toast.tone ?? 'neutral' }];
    this.emit();
    return id;
  }

  dismiss(id: string): void {
    const next = this.toasts.filter((toast) => toast.id !== id);
    if (next.length === this.toasts.length) return;
    this.toasts = next;
    this.emit();
  }

  /** Calls back immediately with what is already showing, then on every change. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.toasts);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.toasts);
  }
}

export const toastBus = new ToastBus();
