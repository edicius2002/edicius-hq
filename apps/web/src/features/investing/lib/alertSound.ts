import type { AlertKind } from '@/features/investing/data/priceAlerts';

/**
 * The beep that goes with a fired alert's toast.
 *
 * Browsers refuse to play audio that was not started as the direct result of
 * a user gesture. A price crossing has no accompanying click — it happens in
 * the background, on whatever page the tab is showing — so the standard
 * mitigation is used: one `AudioContext`, created lazily, resumed once on the
 * page's first pointer or key event and never touched again. By the time any
 * alert can realistically fire, real market data has had to load, which the
 * user has already interacted with the page to see — so this is a one-line
 * tripwire, not a UX gate. If the context is still suspended when a rule
 * fires (a tab opened and never touched), `play` is a silent no-op: a failed
 * beep must never take the toast down with it.
 */

type AudioContextFactory = () => AudioContext;

const RealAudioContext: (new () => AudioContext) | undefined =
  typeof window === 'undefined'
    ? undefined
    : (window.AudioContext ??
      (window as unknown as { webkitAudioContext?: new () => AudioContext }).webkitAudioContext);

const AudioContextCtor: AudioContextFactory | undefined = RealAudioContext
  ? () => new RealAudioContext()
  : undefined;

/** One octave apart and both far from a notification chime already in use elsewhere, so they read as this app's own pair of tones rather than as each other. */
const FREQUENCY_HZ: Record<AlertKind, number> = { buy: 880, sell: 440 };
const DURATION_S = 0.18;
const PEAK_GAIN = 0.15;

export type AlertSoundPlayer = {
  /** Safe to call on every gesture; a no-op once armed. */
  arm: () => void;
  armed: boolean;
  muted: boolean;
  setMuted: (muted: boolean) => void;
  /** Never throws. */
  play: (kind: AlertKind) => void;
};

/**
 * Built with an injectable factory so a test can supply a fake `AudioContext`
 * — jsdom has none — the same way `QuoteBus` takes an injectable fetcher.
 */
export function createAlertSoundPlayer(factory: AudioContextFactory | undefined): AlertSoundPlayer {
  let context: AudioContext | null = null;
  let muted = false;

  function ensureContext(): AudioContext | null {
    if (context) return context;
    if (!factory) return null;
    try {
      context = factory();
      return context;
    } catch {
      return null;
    }
  }

  return {
    get armed() {
      return context !== null && context.state === 'running';
    },
    get muted() {
      return muted;
    },
    setMuted(next: boolean) {
      muted = next;
    },
    arm() {
      const ctx = ensureContext();
      if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    },
    play(kind: AlertKind) {
      if (muted) return;
      const ctx = ensureContext();
      if (!ctx || ctx.state !== 'running') return;

      try {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.frequency.value = FREQUENCY_HZ[kind];
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        // A short envelope rather than a hard stop, so the tone reads as a
        // beep and not a click.
        gain.gain.setValueAtTime(PEAK_GAIN, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + DURATION_S);
        oscillator.start();
        oscillator.stop(ctx.currentTime + DURATION_S);
      } catch {
        // Same rule as an unarmed context: the toast still stands on its own.
      }
    },
  };
}

/** The player the app uses. Tests build their own with a fake factory. */
export const alertSoundPlayer = createAlertSoundPlayer(AudioContextCtor);

/**
 * Arms `player` on the page's first pointer-down or key-down, anywhere, then
 * detaches itself. Returns the cleanup a `useEffect` expects.
 */
export function armOnFirstGesture(player: AlertSoundPlayer): () => void {
  function onGesture() {
    player.arm();
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
  }

  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);

  return () => {
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
  };
}
