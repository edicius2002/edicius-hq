import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { armOnFirstGesture, createAlertSoundPlayer } from './alertSound';

/**
 * jsdom has no `AudioContext`, so every test supplies its own fake factory —
 * the same injectable-dependency shape `QuoteBus` takes a fetcher with.
 */
function fakeAudioContext() {
  const oscillator = {
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gain = {
    connect: vi.fn(),
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
  };

  const ctx = {
    state: 'suspended' as 'suspended' | 'running',
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => {
      ctx.state = 'running';
    }),
    createOscillator: vi.fn(() => oscillator),
    createGain: vi.fn(() => gain),
  };

  return { ctx, oscillator, gain };
}

describe('createAlertSoundPlayer', () => {
  it('starts unarmed and armed after `arm` resumes a suspended context', async () => {
    const { ctx } = fakeAudioContext();
    const player = createAlertSoundPlayer(() => ctx as unknown as AudioContext);

    expect(player.armed).toBe(false);
    player.arm();
    await Promise.resolve();
    await Promise.resolve();
    expect(player.armed).toBe(true);
  });

  it('never throws if the environment has no AudioContext at all', () => {
    const player = createAlertSoundPlayer(undefined);
    expect(() => player.arm()).not.toThrow();
    expect(() => player.play('buy')).not.toThrow();
    expect(player.armed).toBe(false);
  });

  it('does not play while unarmed — the toast still stands on its own', () => {
    const { ctx } = fakeAudioContext();
    const player = createAlertSoundPlayer(() => ctx as unknown as AudioContext);

    player.play('buy');
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it('plays a distinct tone per alert kind once armed', async () => {
    const { ctx, oscillator } = fakeAudioContext();
    const player = createAlertSoundPlayer(() => ctx as unknown as AudioContext);
    player.arm();
    await Promise.resolve();
    await Promise.resolve();

    player.play('buy');
    const buyFrequency = oscillator.frequency.value;
    player.play('sell');
    const sellFrequency = oscillator.frequency.value;

    expect(buyFrequency).not.toBe(sellFrequency);
    expect(oscillator.start).toHaveBeenCalledTimes(2);
  });

  it('does not play while muted, even when armed', async () => {
    const { ctx } = fakeAudioContext();
    const player = createAlertSoundPlayer(() => ctx as unknown as AudioContext);
    player.arm();
    await Promise.resolve();
    await Promise.resolve();
    player.setMuted(true);

    player.play('buy');
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(player.muted).toBe(true);
  });

  it('never throws even if the context itself throws while playing', async () => {
    const { ctx } = fakeAudioContext();
    ctx.createOscillator = vi.fn(() => {
      throw new Error('blocked');
    });
    const player = createAlertSoundPlayer(() => ctx as unknown as AudioContext);
    player.arm();
    await Promise.resolve();
    await Promise.resolve();

    expect(() => player.play('buy')).not.toThrow();
  });
});

describe('armOnFirstGesture', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('arms on the first pointerdown and detaches itself afterwards', () => {
    const player = { arm: vi.fn(), armed: false, muted: false, setMuted: vi.fn(), play: vi.fn() };
    const detach = armOnFirstGesture(player);

    window.dispatchEvent(new Event('pointerdown'));
    expect(player.arm).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('pointerdown'));
    expect(player.arm).toHaveBeenCalledTimes(1);

    detach();
  });
});
