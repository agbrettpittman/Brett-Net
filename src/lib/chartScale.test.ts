import { describe, expect, it } from 'vitest';
import { latencyRange, MIN_SPAN_MS } from './chartScale';

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
    // A negative minimum means down-lanes are drawn below the axis; clamping
    // the floor at zero would hide them entirely.
    const [lo, hi] = latencyRange(-12, 40);
    expect(lo).toBeLessThanOrEqual(-12);
    expect(hi).toBeGreaterThan(40);
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

  it('handles a single flat value', () => {
    const [lo, hi] = latencyRange(30, 30);
    expect(hi - lo).toBeCloseTo(MIN_SPAN_MS, 5);
    expect(lo).toBeLessThanOrEqual(30);
    expect(hi).toBeGreaterThanOrEqual(30);
  });
});
