import { describe, expect, it } from 'vitest';
import {
  AWAKE_DURATIONS,
  AWAKE_MODES,
  DEFAULT_AWAKE_SEC,
  formatRemaining,
} from './keepAwake';

describe('formatRemaining', () => {
  it('counts down in m:ss under an hour', () => {
    expect(formatRemaining(5 * 60 * 1000)).toBe('5:00');
    expect(formatRemaining(61_000)).toBe('1:01');
    expect(formatRemaining(9_000)).toBe('0:09');
  });

  it('adds hours when there are any', () => {
    expect(formatRemaining(8 * 3600 * 1000)).toBe('8:00:00');
    expect(formatRemaining(3661_000)).toBe('1:01:01');
  });

  it('clamps at zero rather than showing a negative', () => {
    // The tick can land after the deadline but before the backend's expiry
    // event arrives, and a flash of "-0:01" reads as a bug.
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(-5000)).toBe('0:00');
  });

  it('rounds up, so the last second is shown as 0:01 not 0:00', () => {
    expect(formatRemaining(500)).toBe('0:01');
  });
});

describe('AWAKE_DURATIONS', () => {
  it('offers the default', () => {
    expect(AWAKE_DURATIONS.some((d) => d.sec === DEFAULT_AWAKE_SEC)).toBe(true);
  });

  it('tops out at eight hours before the unlimited option', () => {
    const finite = AWAKE_DURATIONS.filter((d) => d.sec > 0);
    expect(Math.max(...finite.map((d) => d.sec))).toBe(8 * 60 * 60);
  });

  it('puts "no limit" last, so it has to be chosen deliberately', () => {
    expect(AWAKE_DURATIONS.at(-1)?.sec).toBe(0);
    expect(AWAKE_DURATIONS.filter((d) => d.sec === 0)).toHaveLength(1);
  });

  it('ascends, so the list reads as a scale', () => {
    const finite = AWAKE_DURATIONS.filter((d) => d.sec > 0).map((d) => d.sec);
    expect(finite).toEqual([...finite].sort((a, b) => a - b));
  });
});

describe('AWAKE_MODES', () => {
  it('starts with off, so the first option is the harmless one', () => {
    expect(AWAKE_MODES[0]?.value).toBe('off');
  });

  it('describes every mode', () => {
    for (const m of AWAKE_MODES) {
      expect(m.label.length, m.value).toBeGreaterThan(0);
      expect(m.hint.length, m.value).toBeGreaterThan(0);
    }
  });
});
