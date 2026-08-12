import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { HostSpec } from '../../lib/ipc';
import type { SeriesStore } from '../../lib/series';
import { chartTheme, seriesStyle } from '../../lib/palette';
import { latencyRange, withLanes } from '../../lib/chartScale';
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
 * *shape* changes — the host list, its labels/colours, or the theme.
 *
 * Every host gets two series: the latency line, and a "down lane" drawn below
 * zero. The lane is all-null while the host is healthy, so the series count
 * stays fixed and a host failing never forces the chart to be recreated.
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
  const zoomedRef = useRef(false);
  const [zoomed, setZoomed] = useState(false);
  /** Non-zero while any host is showing a down lane; drives the zero baseline. */
  const laneStep = useRef(0);
  /** Axis range computed in build(); the y scale reads it verbatim. */
  const yRange = useRef<[number, number]>([0, 10]);

  const setZoom = (on: boolean) => {
    zoomedRef.current = on;
    setZoomed(on);
  };

  const hostKey = hosts.map((h) => `${h.id}:${h.label}:${h.color ?? ''}`).join('|');

  function build(): uPlot.AlignedData {
    const ids = hosts.map((h) => h.id);
    const [xs, ...series] = store.aligned(ids);
    const starts = ids.map((id) => store.startIndex(id));
    const b = windowAndBucket(xs, series, starts, spanSec, bucketSec);

    // Only hosts failing somewhere in view get a lane, and they stack in host
    // order so two failing hosts never draw on top of each other.
    const rank = new Map<number, number>();
    b.down.forEach((d, i) => {
      if (d.some(Boolean)) rank.set(i, rank.size);
    });

    // The axis is derived from the *latency* values only, then widened to fit
    // the lane band. Deriving it from the plotted data instead would be
    // circular — lane positions depend on the range — and clips the lanes.
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of b.ys) {
      for (const v of s) {
        if (v == null) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const base = Number.isFinite(lo) ? latencyRange(lo, hi) : latencyRange(null, null);
    const { range, gap } = withLanes(base, rank.size);
    yRange.current = range;
    laneStep.current = gap;

    const lanes = b.ys.map((s, i) => {
      const r = rank.get(i);
      if (r === undefined) return s.map(() => null);
      const y = -gap * (r + 1);
      return b.down[i]!.map((d) => (d ? y : null));
    });

    return [b.xs, ...b.ys, ...lanes] as uPlot.AlignedData;
  }

  useEffect(() => {
    const el = container.current;
    if (!el) return;

    const colors = chartTheme(theme);

    const opts: uPlot.Options = {
      width: el.clientWidth || 800,
      height: el.clientHeight || 320,
      legend: { show: false },
      padding: [12, 12, 0, 0],
      scales: {
        x: { time: true },
        // Verbatim from build(); see the note there about circularity.
        y: { range: () => yRange.current },
      },
      axes: [
        {
          stroke: colors.axis,
          grid: { stroke: colors.grid, width: 1 },
          ticks: { stroke: colors.grid, width: 1 },
          font: '11px system-ui, sans-serif',
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
          // Below zero is the down-lane band, not a latency of -20ms.
          values: (_u, splits) => splits.map((v) => (v < 0 ? '' : `${v} ms`)),
        },
      ],
      cursor: { focus: { prox: 24 }, points: { size: 6 } },
      hooks: {
        setSelect: [
          (u) => {
            if (u.select.width > 0) setZoom(true);
          },
        ],
        // Mark where zero is, so the lanes below it read as "off the scale"
        // rather than as negative latency.
        draw: [
          (u) => {
            if (laneStep.current <= 0) return;
            const ctx = u.ctx;
            const y = Math.round(u.valToPos(0, 'y', true)) + 0.5;
            ctx.save();
            ctx.beginPath();
            // The lane series leave a dash pattern on the context; clear it or
            // this baseline draws dashed and reads as another failing host.
            ctx.setLineDash([]);
            ctx.strokeStyle = colors.axis;
            ctx.globalAlpha = 0.5;
            ctx.lineWidth = 1;
            ctx.moveTo(u.bbox.left, y);
            ctx.lineTo(u.bbox.left + u.bbox.width, y);
            ctx.stroke();
            ctx.restore();
          },
        ],
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
            paths: uPlot.paths.spline?.(),
            spanGaps: false,
            points: { show: false },
          } satisfies uPlot.Series;
        }),
        // Down lanes: same colour, dashed, straight (no spline — these are
        // status bars, not measurements).
        ...hosts.map((h, i) => {
          const style = seriesStyle(i, theme);
          return {
            label: `${h.label} (down)`,
            stroke: h.color ?? style.stroke,
            width: 2,
            dash: [4, 4],
            spanGaps: false,
            points: { show: false },
          } satisfies uPlot.Series;
        }),
      ],
    };

    const u = new uPlot(opts, build(), el);
    chart.current = u;

    const ro = new ResizeObserver(() => {
      u.setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);

    const onDblClick = () => setZoom(false);
    el.addEventListener('dblclick', onDblClick);

    return () => {
      el.removeEventListener('dblclick', onDblClick);
      ro.disconnect();
      u.destroy();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey, theme]);

  // Changing the span or bucket changes the data domain entirely, so any zoom
  // into the old domain is meaningless.
  useEffect(() => {
    setZoom(false);
  }, [spanSec, bucketSec]);

  useEffect(() => {
    // resetScales: false keeps a user's zoom. When not zoomed it must stay true,
    // or the view would freeze at the first window and never follow new data.
    chart.current?.setData(build(), !zoomedRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, hostKey, spanSec, bucketSec]);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />
      {zoomed && (
        <button
          onClick={() => {
            const u = chart.current;
            setZoom(false);
            u?.setData(build(), true);
          }}
          className="absolute right-3 top-2 rounded-md border border-border bg-surface/90 px-2 py-0.5 text-xs text-text-muted backdrop-blur transition-colors hover:text-text"
          title="Double-clicking the chart does this too"
        >
          Reset zoom
        </button>
      )}
    </div>
  );
}
