/** Narrowest y-axis window, in ms, so a steady line is not magnified into noise. */
export const MIN_SPAN_MS = 10;

/**
 * Y-axis range for the latency chart.
 *
 * Fits the data rather than anchoring at zero — latency *variation* is the
 * signal, and a zero-anchored axis squashes it into a sliver. Never goes
 * negative, since latency cannot.
 */
export function latencyRange(
  min: number | null | undefined,
  max: number | null | undefined,
): [number, number] {
  if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, MIN_SPAN_MS];
  }

  const pad = Math.max((max - min) * 0.15, 1);
  let lo = Math.max(0, min - pad);
  let hi = max + pad;

  if (hi - lo < MIN_SPAN_MS) {
    const mid = (lo + hi) / 2;
    lo = Math.max(0, mid - MIN_SPAN_MS / 2);
    hi = lo + MIN_SPAN_MS;
  }

  return [lo, hi];
}
