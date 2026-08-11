import { describe, expect, it } from 'vitest';
import { seriesStyle } from './palette';

describe('seriesStyle', () => {
  it('gives the first ten hosts distinct solid colours', () => {
    const styles = Array.from({ length: 10 }, (_, i) => seriesStyle(i, 'light'));
    const strokes = new Set(styles.map((s) => s.stroke));
    expect(strokes.size).toBe(10);
    expect(styles.every((s) => s.dash === undefined)).toBe(true);
  });

  it('reuses hues but adds a dash on the second cycle', () => {
    const first = seriesStyle(0, 'light');
    const eleventh = seriesStyle(10, 'light');
    expect(eleventh.stroke).toBe(first.stroke);
    expect(first.dash).toBeUndefined();
    expect(eleventh.dash).toBeDefined();
  });

  it('varies lightness between themes', () => {
    expect(seriesStyle(0, 'light').stroke).not.toBe(seriesStyle(0, 'dark').stroke);
  });

  it('keeps consecutive series far apart on the hue wheel', () => {
    // Regression guard: an earlier ordering put hue 255 next to 275, which
    // rendered two hosts as visually identical blues.
    const hue = (i: number) => {
      const m = /oklch\([\d.]+% [\d.]+ ([\d.]+)\)/.exec(seriesStyle(i, 'light').stroke);
      return Number(m![1]);
    };
    for (let i = 0; i < 9; i++) {
      const d = Math.abs(hue(i) - hue(i + 1));
      const circular = Math.min(d, 360 - d);
      expect(circular).toBeGreaterThanOrEqual(60);
    }
  });

  it('alternates lightness so neighbours differ on a second channel', () => {
    const l = (i: number) =>
      Number(/oklch\(([\d.]+)%/.exec(seriesStyle(i, 'light').stroke)![1]);
    for (let i = 0; i < 9; i++) {
      expect(l(i)).not.toBe(l(i + 1));
    }
  });

  it('never returns undefined for a large index', () => {
    const s = seriesStyle(137, 'dark');
    expect(s.stroke).toMatch(/^oklch\(/);
  });
});
