/** Narrowest y-axis window, in ms, so a steady line is not magnified into noise. */
export const MIN_SPAN_MS = 10;

/**
 * Reserves a band beneath the plotted latency for down-lanes.
 *
 * The band hangs below `divider` — the fitted latency floor — rather than below
 * absolute zero. Anchoring at zero would drag the axis down to include it and
 * squash the actual measurements into the top of the chart, which is the worst
 * possible moment to lose vertical resolution. The divider is drawn as a
 * baseline and labels below it are suppressed, so the meaning is the same:
 * anything under the line is not responding.
 *
 * The range is computed explicitly rather than derived from the plotted data —
 * lane positions depend on the range and the range depends on the lanes, so
 * letting the chart library infer it from min/max is circular and clips them.
 */
export function withLanes(
  range: [number, number],
  laneCount: number,
): { range: [number, number]; gap: number; divider: number } {
  const [lo, hi] = range;
  if (laneCount <= 0) return { range, gap: 0, divider: lo };

  // Proportional to the visible latency band, so the spacing looks the same
  // whether the chart is showing 2ms or 400ms.
  const gap = Math.max((hi - lo) * 0.08, 1);
  // The trailing 0.6 leaves breathing room under the deepest lane.
  return { range: [lo - gap * (laneCount + 0.6), hi], gap, divider: lo };
}

/**
 * Y-axis range for the latency chart.
 *
 * Fits the data rather than anchoring at zero — latency *variation* is the
 * signal, and a zero-anchored axis squashes it into a sliver.
 *
 * The floor is clamped at zero because latency cannot be negative — unless the
 * data already goes negative, which means down-lanes are being drawn below the
 * axis and must stay visible.
 */
export function latencyRange(
  min: number | null | undefined,
  max: number | null | undefined,
): [number, number] {
  if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, MIN_SPAN_MS];
  }

  const pad = Math.max((max - min) * 0.15, 1);
  const floor = min < 0 ? min - pad : 0;
  let lo = Math.max(floor, min - pad);
  let hi = max + pad;

  if (hi - lo < MIN_SPAN_MS) {
    const mid = (lo + hi) / 2;
    lo = Math.max(floor, mid - MIN_SPAN_MS / 2);
    hi = lo + MIN_SPAN_MS;
  }

  return [lo, hi];
}
