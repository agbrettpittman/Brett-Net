import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { HostSpec } from '../../lib/ipc';
import type { SeriesStore } from '../../lib/series';
import { chartTheme, seriesStyle } from '../../lib/palette';
import { latencyRange } from '../../lib/chartScale';
import { windowAndBucket } from '../../lib/aggregate';

interface Props {
  store: SeriesStore;
  hosts: HostSpec[];
  theme: string;
  /** Visible window in seconds; 0 shows everything retained. */
  spanSec: number;
  /** Averaging bucket in seconds; 0 plots every sample. */
  bucketSec: number;
  /** Bumped by the parent to signal new samples; drives an imperative redraw. */
  revision: number;
}

/**
 * Live latency chart.
 *
 * The instance is created imperatively and fed via `setData`, so incoming
 * samples never pass through React state. The chart is only rebuilt when its
 * *shape* changes — the host list or the theme.
 */
export function LatencyChart({
  store,
  hosts,
  theme,
  spanSec,
  bucketSec,
  revision,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<uPlot | null>(null);

  // Rebuild when the series *shape* changes: identity, label, or colour.
  const hostKey = hosts.map((h) => `${h.id}:${h.label}:${h.color ?? ''}`).join('|');

  const data = () => {
    const [xs, ...series] = store.aligned(hosts.map((h) => h.id));
    return windowAndBucket(xs, series, spanSec, bucketSec) as uPlot.AlignedData;
  };

  useEffect(() => {
    const el = container.current;
    if (!el) return;

    const colors = chartTheme(theme);

    const opts: uPlot.Options = {
      width: el.clientWidth || 800,
      height: el.clientHeight || 320,
      // The host table doubles as the legend.
      legend: { show: false },
      padding: [12, 12, 0, 0],
      scales: {
        x: { time: true },
        y: { range: (_u, min, max) => latencyRange(min, max) },
      },
      axes: [
        {
          stroke: colors.axis,
          grid: { stroke: colors.grid, width: 1 },
          ticks: { stroke: colors.grid, width: 1 },
          font: '11px system-ui, sans-serif',
          // uPlot's default time axis drops to ":48.500" at short ranges and
          // adds a second row for the date. Clock time is what matters here.
          values: (_u, splits) =>
            splits.map((s) =>
              new Date(s * 1000).toLocaleTimeString(undefined, {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              }),
            ),
        },
        {
          stroke: colors.axis,
          grid: { stroke: colors.grid, width: 1 },
          ticks: { stroke: colors.grid, width: 1 },
          font: '11px system-ui, sans-serif',
          values: (_u, splits) => splits.map((v) => `${v} ms`),
        },
      ],
      cursor: {
        focus: { prox: 24 },
        points: { size: 6 },
      },
      series: [
        {},
        ...hosts.map((h, i) => {
          const style = seriesStyle(i, theme);
          return {
            label: h.label,
            stroke: h.color ?? style.stroke,
            width: 1.5,
            dash: h.color ? undefined : style.dash,
            // Cubic interpolation. Splines can overshoot slightly between
            // points, so the curve may dip a hair below the true minimum —
            // acceptable here, and far easier to read a trend from.
            paths: uPlot.paths.spline?.(),
            // A timeout is a null: leave a visible break rather than drawing a
            // straight line across the outage as though nothing happened.
            spanGaps: false,
            points: { show: false },
          } satisfies uPlot.Series;
        }),
      ],
    };

    const u = new uPlot(opts, data(), el);
    chart.current = u;

    const ro = new ResizeObserver(() => {
      u.setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      u.destroy();
      chart.current = null;
    };
    // `hostKey` stands in for the host list identity; `store` is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey, theme]);

  useEffect(() => {
    chart.current?.setData(data());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, hostKey, spanSec, bucketSec]);

  return <div ref={container} className="h-full w-full" />;
}
