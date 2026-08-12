import { describe, expect, it } from 'vitest';
import { latencyRange, withLanes, MIN_SPAN_MS } from './chartScale';

describe('latencyRange', () => {
  it('falls back to a sane window with no data', () => {
    expect(latencyRange(null, null)).toEqual([0, MIN_SPAN_MS]);
    expect(latencyRange(undefined, undefined)).toEqual([0, MIN_SPAN_MS]);
  });

  it('ignores non-finite input', () => {
    expect(latencyRange(NaN, 10)).toEqual([0, MIN_SPAN_MS]);
    expect(latencyRange(0, Infinity)).toEqual([0, MIN_SPAN_MS]);
  });

  it('fits the data instead of anchoring at zero', () => {
    const [lo, hi] = latencyRange(20, 45);
    // The whole point: the window should sit near the data, not start at 0.
    expect(lo).toBeGreaterThan(10);
    expect(lo).toBeLessThan(20);
    expect(hi).toBeGreaterThan(45);
  });

  it('pads above and below', () => {
    const [lo, hi] = latencyRange(100, 200);
    expect(lo).toBeCloseTo(85, 5);
    expect(hi).toBeCloseTo(215, 5);
  });

  it('never goes negative for ordinary latency data', () => {
    const [lo] = latencyRange(0.2, 0.9);
    expect(lo).toBeGreaterThanOrEqual(0);
  });

  it('keeps room below zero when down-lanes are present', () => {
    const [lo, hi] = latencyRange(-12, 40);
    expect(lo).toBeLessThanOrEqual(-12);
    expect(hi).toBeGreaterThan(40);
  });
});

describe('withLanes', () => {
  it('leaves the range untouched with no lanes', () => {
    const base: [number, number] = [0, 50];
    const r = withLanes(base, 0);
    expect(r.range).toEqual(base);
    expect(r.gap).toBe(0);
  });

  it('extends the floor below zero once a lane exists', () => {
    const { range, gap } = withLanes([0, 50], 1);
    expect(gap).toBeGreaterThan(0);
    expect(range[0]).toBeLessThan(0);
    expect(range[1]).toBe(50);
  });

  it('puts every lane strictly below zero and inside the range', () => {
    const laneCount = 4;
    const { range, gap } = withLanes([0, 50], laneCount);
    for (let k = 0; k < laneCount; k++) {
      const y = -gap * (k + 1);
      expect(y).toBeLessThan(0);
      expect(y).toBeGreaterThan(range[0]);
    }
  });

  it('stacks lanes without overlapping', () => {
    const { gap } = withLanes([0, 50], 3);
    const ys = [0, 1, 2].map((k) => -gap * (k + 1));
    expect(new Set(ys).size).toBe(3);
    expect(ys[0]).toBeGreaterThan(ys[1]!);
    expect(ys[1]).toBeGreaterThan(ys[2]!);
  });

  it('deepens the floor as lanes are added', () => {
    const one = withLanes([0, 50], 1).range[0];
    const three = withLanes([0, 50], 3).range[0];
    expect(three).toBeLessThan(one);
  });

  it('scales spacing with the latency band', () => {
    const small = withLanes([0, 10], 1).gap;
    const large = withLanes([0, 400], 1).gap;
    expect(large).toBeGreaterThan(small);
  });

  it('keeps a usable gap for a very narrow band', () => {
    // Without a floor the lanes would collapse onto the zero line.
    expect(withLanes([20, 21], 2).gap).toBeGreaterThanOrEqual(1);
  });

  it('enforces a minimum span for a near-flat series', () => {
    const [lo, hi] = latencyRange(25, 25.4);
    expect(hi - lo).toBeCloseTo(MIN_SPAN_MS, 5);
    // and still brackets the data
    expect(lo).toBeLessThanOrEqual(25);
    expect(hi).toBeGreaterThanOrEqual(25.4);
  });

  it('does not force the minimum span when the data is already wider', () => {
    const [lo, hi] = latencyRange(10, 400);
    expect(hi - lo).toBeGreaterThan(MIN_SPAN_MS);
  });

  it('handles a single flat value (unchanged by lanes)', () => {
    const [lo, hi] = latencyRange(30, 30);
    expect(hi - lo).toBeCloseTo(MIN_SPAN_MS, 5);
    expect(lo).toBeLessThanOrEqual(30);
    expect(hi).toBeGreaterThanOrEqual(30);
  });
});
