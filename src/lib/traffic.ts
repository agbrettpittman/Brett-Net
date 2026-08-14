/** Mirrors `traffic::InterfaceCounters`. Byte totals since the machine booted. */
export interface InterfaceCounters {
  /** Stable key, matching `Adapter.luid`. */
  luid: string;
  name: string;
  inOctets: number;
  outOctets: number;
}

/** Mirrors `traffic::CounterSample`. */
export interface CounterSample {
  /** Unix epoch milliseconds, taken beside the read. */
  t: number;
  interfaces: InterfaceCounters[];
}

/** A rate for one interface, in **bits** per second. */
export interface Throughput {
  luid: string;
  name: string;
  inBps: number;
  outBps: number;
}

/** Running **byte** totals since the app started watching, keyed by LUID. */
export type Totals = ReadonlyMap<string, { inBytes: number; outBytes: number }>;

/**
 * Longest gap between two reads that still yields a rate.
 *
 * A suspended laptop or a stalled event loop leaves a much bigger gap, and
 * dividing an hour of traffic by an hour draws a flat, meaningless bar across
 * the chart as if that had been the rate all along. Better to draw nothing.
 */
export const MAX_ELAPSED_SEC = 30;

/**
 * Bytes added between two reads.
 *
 * A counter that went backwards was reset — a driver reload, or disabling and
 * re-enabling the adapter. Subtracting would produce an enormous negative
 * number, so the interval is counted as zero and the next read re-baselines
 * against the new value.
 */
function rise(before: number, after: number): number {
  return after >= before ? after - before : 0;
}

function byLuid(sample: CounterSample): Map<string, InterfaceCounters> {
  return new Map(sample.interfaces.map((i) => [i.luid, i]));
}

/**
 * Rates between two reads.
 *
 * Interfaces absent from the earlier read are skipped: one sample is a total,
 * not a rate, so a newly-appeared adapter reports nothing until its second.
 */
export function throughput(prev: CounterSample | null, next: CounterSample): Throughput[] {
  if (!prev) return [];
  const elapsed = (next.t - prev.t) / 1000;
  if (elapsed <= 0 || elapsed > MAX_ELAPSED_SEC) return [];

  const before = byLuid(prev);
  const out: Throughput[] = [];

  for (const now of next.interfaces) {
    const was = before.get(now.luid);
    if (!was) continue;
    out.push({
      luid: now.luid,
      name: now.name,
      inBps: (rise(was.inOctets, now.inOctets) * 8) / elapsed,
      outBps: (rise(was.outOctets, now.outOctets) * 8) / elapsed,
    });
  }
  return out;
}

/**
 * Adds one interval's bytes to the running totals.
 *
 * Deliberately has no `MAX_ELAPSED_SEC` cutoff, unlike [`throughput`]. Traffic
 * that crossed the wire while the machine was asleep still crossed it, so it
 * belongs in the total even though it would be a nonsense instantaneous rate.
 */
export function accumulate(
  totals: Totals,
  prev: CounterSample | null,
  next: CounterSample,
): Totals {
  if (!prev || next.t <= prev.t) return totals;

  const before = byLuid(prev);
  const out = new Map(totals);

  for (const now of next.interfaces) {
    const was = before.get(now.luid);
    if (!was) continue;
    const running = out.get(now.luid) ?? { inBytes: 0, outBytes: 0 };
    out.set(now.luid, {
      inBytes: running.inBytes + rise(was.inOctets, now.inOctets),
      outBytes: running.outBytes + rise(was.outOctets, now.outOctets),
    });
  }
  return out;
}

/**
 * A rate, in bits per second.
 *
 * Bits rather than bytes because that is the unit a link speed is quoted in, so
 * "4.2 Mbps on a 1 Gbps link" is directly comparable.
 */
export function formatRate(bps: number): string {
  if (!Number.isFinite(bps) || bps < 1) return '0 bps';
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} Kbps`;
  return `${Math.round(bps)} bps`;
}

/**
 * A volume, in bytes.
 *
 * Binary units labelled the Windows way (`MB` meaning 1,048,576), so the
 * numbers line up with Task Manager rather than disagreeing with it by 5%.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 2 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * Turns per-interface series into cumulative ones, for a stacked chart.
 *
 * Each output is the running total of every series up to and including it, so
 * consecutive outputs bound one interface's band. A missing value counts as
 * zero — an interface with nothing to report contributes an empty band rather
 * than punching a hole through the interfaces above it.
 *
 * A column where *every* series is missing stays null in all of them, so a real
 * gap in the data is still drawn as a gap.
 */
export function stackSeries(series: (number | null)[][]): (number | null)[][] {
  if (series.length === 0) return [];

  const length = series[0]?.length ?? 0;
  const out = series.map(() => new Array<number | null>(length).fill(null));

  for (let col = 0; col < length; col += 1) {
    if (!series.some((s) => s[col] != null)) continue;

    let running = 0;
    for (let i = 0; i < series.length; i += 1) {
      running += series[i]?.[col] ?? 0;
      out[i]![col] = running;
    }
  }
  return out;
}

/**
 * Rounds up to the next 1, 2 or 5 times a power of ten.
 *
 * The throughput axis needs this. Left to pick its own increments over an
 * arbitrary range, uPlot chose a step larger than the range itself, so every
 * tick but zero fell outside the plot and the chart came out with a single
 * unlabelled axis — visibly a graph, but impossible to read a number off.
 * Snapping the extent to a round number puts the ticks back inside it.
 */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Short axis label for the throughput chart, where space is tight. */
export function formatRateTick(bps: number): string {
  if (bps >= 1e9) return `${+(bps / 1e9).toFixed(1)}G`;
  if (bps >= 1e6) return `${+(bps / 1e6).toFixed(1)}M`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)}k`;
  return `${Math.round(bps)}`;
}
