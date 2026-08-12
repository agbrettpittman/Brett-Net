/** Narrowest y-axis window, in ms, so a steady line is not magnified into noise. */
export const MIN_SPAN_MS = 10;

/**
 * Reserves a band below zero for down-lanes and returns the adjusted axis range
 * plus the spacing between lanes.
 *
 * The range is computed explicitly rather than derived from the plotted data:
 * the lane positions depend on the range and the range depends on the lanes, so
 * letting the chart library infer it from min/max is circular and ends up
 * clipping the lanes out of view.
 *
 * Lane `k` sits at `-gap * (k + 1)`, so lanes are always strictly below zero
 * regardless of how high the latency range goes.
 */
export function withLanes(
  range: [number, number],
  laneCount: number,
): { range: [number, number]; gap: number } {
  if (laneCount <= 0) return { range, gap: 0 };

  const [lo, hi] = range;
  // Proportional to the visible latency band, so the spacing looks the same
  // whether the chart is showing 2ms or 400ms.
  const gap = Math.max((hi - Math.max(lo, 0)) * 0.08, 1);
  // The trailing 0.6 leaves breathing room under the deepest lane.
  return { range: [-gap * (laneCount + 0.6), hi], gap };
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
