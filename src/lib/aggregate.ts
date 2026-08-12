import type { Series } from './series';

/** Aggregation bucket sizes, in seconds. 0 means "every sample, no averaging". */
export const BUCKETS = [
  { sec: 0, label: 'Raw' },
  { sec: 5, label: '5s' },
  { sec: 15, label: '15s' },
  { sec: 30, label: '30s' },
  { sec: 60, label: '1m' },
  { sec: 300, label: '5m' },
] as const;

/** Visible time windows, in seconds. 0 means "everything retained". */
export const SPANS = [
  { sec: 60, label: '1m' },
  { sec: 300, label: '5m' },
  { sec: 900, label: '15m' },
  { sec: 1800, label: '30m' },
  { sec: 3600, label: '1h' },
  { sec: 0, label: 'All' },
] as const;

export interface Bucketed {
  xs: number[];
  ys: Series[];
  /**
   * Per series, per bucket: the host was being probed but nothing replied.
   *
   * Distinct from a plain `null` in `ys`, which also covers "this host did not
   * exist yet". Only this flag means *failing*.
   */
  down: boolean[][];
}

/**
 * Trims to the most recent `spanSec` and averages samples into `bucketSec`
 * buckets.
 *
 * `starts[i]` is the column index at which series `i` began being probed;
 * anything before it is back-fill and is never reported as down.
 *
 * Buckets are aligned to absolute multiples of `bucketSec` rather than to the
 * newest sample, so a bucket covers a fixed wall-clock window and points do not
 * slide sideways as new data arrives.
 *
 * A bucket containing no successful samples yields `null` — a gap — rather than
 * being dropped. Averaging only non-null values means an outage never pulls the
 * average down; it shows up as a break in the line and in the loss figures.
 */
export function windowAndBucket(
  xs: number[],
  series: Series[],
  starts: number[],
  spanSec: number,
  bucketSec: number,
): Bucketed {
  if (xs.length === 0) {
    return { xs: [], ys: series.map(() => []), down: series.map(() => []) };
  }

  let start = 0;
  if (spanSec > 0) {
    const cutoff = xs[xs.length - 1]! - spanSec;
    // xs is monotonically increasing, so a linear scan from the front is fine
    // at these sizes and avoids a binary-search off-by-one.
    while (start < xs.length && xs[start]! < cutoff) start++;
  }

  const wx = xs.slice(start);
  const ws = series.map((s) => s.slice(start));
  // Re-base each start against the trimmed window.
  const wStarts = starts.map((s) => Math.max(0, s - start));

  if (bucketSec <= 0) {
    return {
      xs: wx,
      ys: ws,
      down: ws.map((s, si) => s.map((v, i) => v == null && i >= wStarts[si]!)),
    };
  }

  const bucketStarts: number[] = [];
  const indexOfBucket = new Map<number, number>();
  for (const t of wx) {
    const b = Math.floor(t / bucketSec) * bucketSec;
    if (!indexOfBucket.has(b)) {
      indexOfBucket.set(b, bucketStarts.length);
      bucketStarts.push(b);
    }
  }

  // Plot each average at the centre of the window it summarises.
  const outX = bucketStarts.map((b) => b + bucketSec / 2);

  const outSeries: Series[] = [];
  const outDown: boolean[][] = [];

  ws.forEach((s, si) => {
    const sums = new Float64Array(bucketStarts.length);
    const counts = new Uint32Array(bucketStarts.length);
    const probed = new Uint32Array(bucketStarts.length);
    const from = wStarts[si]!;

    for (let i = 0; i < wx.length; i++) {
      const bi = indexOfBucket.get(Math.floor(wx[i]! / bucketSec) * bucketSec)!;
      if (i >= from) probed[bi]! += 1;
      const v = s[i];
      if (v == null) continue;
      sums[bi]! += v;
      counts[bi]! += 1;
    }

    const ys: Series = new Array(bucketStarts.length);
    const down: boolean[] = new Array(bucketStarts.length);
    for (let i = 0; i < bucketStarts.length; i++) {
      ys[i] = counts[i]! === 0 ? null : sums[i]! / counts[i]!;
      // Probed at least once in this bucket, yet nothing came back.
      down[i] = counts[i]! === 0 && probed[i]! > 0;
    }
    outSeries.push(ys);
    outDown.push(down);
  });

  return { xs: outX, ys: outSeries, down: outDown };
}
