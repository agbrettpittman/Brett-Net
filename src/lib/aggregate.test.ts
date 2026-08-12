import { describe, expect, it } from 'vitest';
import { windowAndBucket } from './aggregate';
import type { Series } from './series';

/** Defaults every series to "probed from the very first column". */
function wb(
  xs: number[],
  series: Series[],
  spanSec: number,
  bucketSec: number,
  starts?: number[],
) {
  return windowAndBucket(xs, series, starts ?? series.map(() => 0), spanSec, bucketSec);
}

describe('windowAndBucket', () => {
  it('handles empty input', () => {
    expect(wb([], [[]], 0, 0)).toEqual({ xs: [], ys: [[]], down: [[]] });
  });

  it('passes data through untouched with no span and no bucket', () => {
    const r = wb([1, 2, 3], [[10, 20, 30]], 0, 0);
    expect(r.xs).toEqual([1, 2, 3]);
    expect(r.ys[0]).toEqual([10, 20, 30]);
  });

  describe('windowing', () => {
    it('keeps only the most recent span', () => {
      const r = wb([100, 110, 120, 130, 140], [[1, 2, 3, 4, 5]], 20, 0);
      expect(r.xs).toEqual([120, 130, 140]);
      expect(r.ys[0]).toEqual([3, 4, 5]);
    });

    it('keeps everything when the span exceeds the data', () => {
      expect(wb([1, 2, 3], [[1, 2, 3]], 9999, 0).xs).toEqual([1, 2, 3]);
    });

    it('windows every series in step', () => {
      const r = wb([0, 10, 20], [[1, 2, 3], [4, 5, 6]], 10, 0);
      expect(r.ys[0]).toEqual([2, 3]);
      expect(r.ys[1]).toEqual([5, 6]);
    });
  });

  describe('bucketing', () => {
    it('averages samples inside each bucket', () => {
      const r = wb([0, 10, 20, 30, 40], [[10, 20, 30, 100, 200]], 0, 30);
      expect(r.ys[0]).toEqual([20, 150]);
      expect(r.xs).toEqual([15, 45]); // bucket centres
    });

    it('aligns buckets to absolute time, not to the first sample', () => {
      expect(wb([25, 35, 45], [[1, 1, 1]], 0, 30).xs).toEqual([15, 45]);
    });

    it('ignores nulls when averaging', () => {
      expect(wb([0, 10, 20], [[10, null, 30]], 0, 30).ys[0]).toEqual([20]);
    });

    it('does not let an outage drag the average toward zero', () => {
      expect(wb([0, 1, 2, 3], [[10, null, null, 10]], 0, 30).ys[0]).toEqual([10]);
    });

    it('keeps series aligned to the bucketed x axis', () => {
      const r = wb([0, 10, 30, 40], [[1, 3, 5, 7], [2, 4, null, null]], 0, 30);
      expect(r.xs).toHaveLength(2);
      expect(r.ys[0]).toEqual([2, 6]);
      expect(r.ys[1]).toEqual([3, null]);
    });

    it('windows before bucketing', () => {
      const r = wb([0, 30, 60, 90], [[1, 2, 3, 4]], 60, 30);
      expect(r.xs).toEqual([45, 75, 105]);
      expect(r.ys[0]).toEqual([2, 3, 4]);
    });
  });

  describe('down detection', () => {
    it('flags raw samples with no reply as down', () => {
      const r = wb([0, 1, 2], [[10, null, 30]], 0, 0);
      expect(r.down[0]).toEqual([false, true, false]);
    });

    it('flags a bucket that was probed but never replied', () => {
      const r = wb([0, 10, 30, 40], [[5, 5, null, null]], 0, 30);
      expect(r.ys[0]).toEqual([5, null]);
      expect(r.down[0]).toEqual([false, true]);
    });

    it('does not flag a bucket that had any success', () => {
      const r = wb([0, 10, 20], [[null, 5, null]], 0, 30);
      expect(r.down[0]).toEqual([false]);
    });

    it('never flags back-fill from before the host existed', () => {
      // Host joined at column 2; the first two nulls are not failures.
      const r = wb([0, 1, 2, 3], [[null, null, null, 5]], 0, 0, [2]);
      expect(r.down[0]).toEqual([false, false, true, false]);
    });

    it('never flags back-fill when bucketed', () => {
      // Joined at column 2, which lands in the second bucket.
      const r = wb([0, 10, 30, 40], [[null, null, null, null]], 0, 30, [2]);
      expect(r.down[0]).toEqual([false, true]);
    });

    it('flags a host that has never once replied', () => {
      const r = wb([0, 1, 2], [[null, null, null]], 0, 0, [0]);
      expect(r.down[0]).toEqual([true, true, true]);
    });

    it('re-bases starts against the trimmed window', () => {
      // Cutoff is 30-20=10, so column 0 drops and start=3 re-bases to 2.
      const r = wb([0, 10, 20, 30], [[null, null, null, null]], 20, 0, [3]);
      expect(r.xs).toEqual([10, 20, 30]);
      expect(r.down[0]).toEqual([false, false, true]);
    });

    it('tracks down independently per series', () => {
      const r = wb([0, 1], [[10, null], [null, null]], 0, 0, [0, 0]);
      expect(r.down[0]).toEqual([false, true]);
      expect(r.down[1]).toEqual([true, true]);
    });
  });
});
