import { describe, expect, it } from 'vitest';
import { windowAndBucket } from './aggregate';

describe('windowAndBucket', () => {
  it('handles empty input', () => {
    expect(windowAndBucket([], [[]], 0, 0)).toEqual([[], []]);
  });

  it('passes data through untouched with no span and no bucket', () => {
    const xs = [1, 2, 3];
    const a = [10, 20, 30];
    expect(windowAndBucket(xs, [a], 0, 0)).toEqual([xs, a]);
  });

  describe('windowing', () => {
    it('keeps only the most recent span', () => {
      const xs = [100, 110, 120, 130, 140];
      const a = [1, 2, 3, 4, 5];
      const [wx, wa] = windowAndBucket(xs, [a], 20, 0);
      // cutoff = 140 - 20 = 120, so 100 and 110 drop
      expect(wx).toEqual([120, 130, 140]);
      expect(wa).toEqual([3, 4, 5]);
    });

    it('keeps everything when the span exceeds the data', () => {
      const xs = [1, 2, 3];
      const [wx] = windowAndBucket(xs, [[1, 2, 3]], 9999, 0);
      expect(wx).toEqual([1, 2, 3]);
    });

    it('windows every series in step', () => {
      const xs = [0, 10, 20];
      const [, a, b] = windowAndBucket(xs, [[1, 2, 3], [4, 5, 6]], 10, 0);
      expect(a).toEqual([2, 3]);
      expect(b).toEqual([5, 6]);
    });
  });

  describe('bucketing', () => {
    it('averages samples inside each bucket', () => {
      // three samples in bucket [0,30), two in [30,60)
      const xs = [0, 10, 20, 30, 40];
      const a = [10, 20, 30, 100, 200];
      const [bx, ba] = windowAndBucket(xs, [a], 0, 30);
      expect(ba).toEqual([20, 150]);
      // plotted at bucket centres
      expect(bx).toEqual([15, 45]);
    });

    it('aligns buckets to absolute time, not to the first sample', () => {
      // 25 falls in [0,30); 35 and 45 fall in [30,60)
      const [bx] = windowAndBucket([25, 35, 45], [[1, 1, 1]], 0, 30);
      expect(bx).toEqual([15, 45]);
    });

    it('ignores nulls when averaging', () => {
      const [, a] = windowAndBucket([0, 10, 20], [[10, null, 30]], 0, 30);
      expect(a).toEqual([20]);
    });

    it('yields null for a bucket with no successful samples', () => {
      const [bx, a] = windowAndBucket([0, 10, 30], [[null, null, 50]], 0, 30);
      expect(bx).toEqual([15, 45]);
      expect(a).toEqual([null, 50]);
    });

    it('does not let an outage drag the average toward zero', () => {
      // Averaging nulls as 0 would give 5; correct answer is 10.
      const [, a] = windowAndBucket([0, 1, 2, 3], [[10, null, null, 10]], 0, 30);
      expect(a).toEqual([10]);
    });

    it('keeps series aligned to the bucketed x axis', () => {
      const xs = [0, 10, 30, 40];
      const [bx, a, b] = windowAndBucket(
        xs,
        [
          [1, 3, 5, 7],
          [2, 4, null, null],
        ],
        0,
        30,
      );
      expect(bx).toHaveLength(2);
      expect(a).toHaveLength(2);
      expect(b).toHaveLength(2);
      expect(a).toEqual([2, 6]);
      expect(b).toEqual([3, null]);
    });

    it('collapses a single bucket to one point', () => {
      const [bx, a] = windowAndBucket([0, 1, 2], [[3, 4, 5]], 0, 60);
      expect(bx).toHaveLength(1);
      expect(a).toEqual([4]);
    });
  });

  it('windows before bucketing', () => {
    const xs = [0, 30, 60, 90];
    const a = [1, 2, 3, 4];
    // span 60 -> cutoff 30, keeps 30/60/90; bucket 30 -> three buckets
    const [bx, ba] = windowAndBucket(xs, [a], 60, 30);
    expect(bx).toEqual([45, 75, 105]);
    expect(ba).toEqual([2, 3, 4]);
  });
});
