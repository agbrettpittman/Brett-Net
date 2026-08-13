import type { HistorySample, PingStatus } from './ipc';

/**
 * Latency in milliseconds, or null for a gap.
 *
 * Only a genuine reply from the target counts. A timeout has no round trip at
 * all, and a TTL-expired reply came from a router in between rather than from
 * the host we asked about — plotting either as a number would invent data.
 *
 * Shared by the live tick handler and the history back-fill so restored samples
 * cannot be interpreted differently from the ones that arrive live.
 */
export function latencyMs(status: PingStatus, rttUs: number | null): number | null {
  return status === 'success' && rttUs !== null ? rttUs / 1000 : null;
}

/** One aligned sample column, ready for `SeriesStore.push`. */
export interface Column {
  /** Seconds — uPlot's time-scale unit. */
  tSec: number;
  values: Map<string, number | null>;
}

/**
 * Longest pause that still counts as the same run of data.
 *
 * Restarting the app, or rebuilding it during development, leaves a gap of a
 * few seconds; five minutes covers that comfortably.
 */
export const CONTINUITY_SEC = 300;

/**
 * Turns stored samples into chart columns, keeping only the most recent
 * unbroken run.
 *
 * The trimming matters: without it, closing the app overnight and reopening it
 * would draw one straight line from yesterday to now, implying measurements
 * that were never taken. Inserting an empty column instead is not an option —
 * a column where every host is null is indistinguishable from every host being
 * down, and would paint a false outage across the chart.
 *
 * Samples for a given tick share a timestamp, so they group into one column.
 *
 * @param maxColumns most recent columns to keep, matching the store's capacity
 */
export function toColumns(
  samples: HistorySample[],
  maxColumns: number,
  gapSec = CONTINUITY_SEC,
): Column[] {
  if (samples.length === 0 || maxColumns <= 0) return [];

  const byTime = new Map<number, Map<string, number | null>>();
  for (const s of samples) {
    let col = byTime.get(s.t);
    if (!col) {
      col = new Map();
      byTime.set(s.t, col);
    }
    col.set(s.hostId, latencyMs(s.status, s.rttUs));
  }

  const times = [...byTime.keys()].sort((a, b) => a - b);
  const columns: Column[] = times.map((t) => ({
    tSec: t / 1000,
    values: byTime.get(t)!,
  }));

  // Walk back from the newest column and cut at the first real break.
  let from = 0;
  for (let i = columns.length - 1; i > 0; i--) {
    if (columns[i]!.tSec - columns[i - 1]!.tSec > gapSec) {
      from = i;
      break;
    }
  }

  return columns.slice(Math.max(from, columns.length - maxColumns));
}
