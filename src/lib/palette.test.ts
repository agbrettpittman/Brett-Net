import { describe, expect, it } from 'vitest';
import { directionalStyle, seriesStyle } from './palette';

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

describe('directionalStyle', () => {
  const parse = (c: string) => {
    const m = /oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)/.exec(c)!;
    return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
  };

  it('gives both directions of an interface the same hue', () => {
    // The point of the scheme: two bands, recognisably one interface.
    for (const theme of ['light', 'dark']) {
      for (let i = 0; i < 12; i++) {
        const s = directionalStyle(i, theme);
        expect(parse(s.received).h, `${theme} ${i}`).toBe(parse(s.sent).h);
      }
    }
  });

  it('makes sent the lighter of the pair, in both themes', () => {
    for (const theme of ['light', 'dark']) {
      const s = directionalStyle(0, theme);
      expect(parse(s.sent).l, theme).toBeGreaterThan(parse(s.received).l);
    }
  });

  it('separates the pair enough to tell them apart', () => {
    for (const theme of ['light', 'dark']) {
      const s = directionalStyle(3, theme);
      expect(parse(s.sent).l - parse(s.received).l, theme).toBeGreaterThanOrEqual(20);
    }
  });

  it('keeps both inside the theme\u2019s visible band rather than at the extremes', () => {
    // Near-white vanishes on the light background and near-black on the dark
    // one, which is why the split is not simply the midpoint of the range.
    const lightTheme = directionalStyle(0, 'light');
    expect(parse(lightTheme.sent).l).toBeLessThan(85);
    const darkTheme = directionalStyle(0, 'dark');
    expect(parse(darkTheme.received).l).toBeGreaterThan(40);
  });

  it('gives adjacent interfaces clearly different hues', () => {
    for (let i = 0; i < 9; i++) {
      const a = parse(directionalStyle(i, 'light').received).h;
      const b = parse(directionalStyle(i + 1, 'light').received).h;
      const d = Math.abs(a - b);
      expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(60);
    }
  });

  it('wraps rather than returning undefined for a large index', () => {
    const s = directionalStyle(137, 'dark');
    expect(s.received).toMatch(/^oklch\(/);
    expect(s.sent).toMatch(/^oklch\(/);
  });
});
