import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { HostSpec } from '../../lib/ipc';
import type { SeriesStore } from '../../lib/series';
import { formatMs } from '../../lib/stats';
import { chartTheme, seriesStyle } from '../../lib/palette';
import { latencyRange, withLanes } from '../../lib/chartScale';
import { windowAndBucket } from '../../lib/aggregate';
import { buildLaneSeries, laneRanks } from '../../lib/lanes';

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
  /** Cursor readout: pixel position plus the hovered bucket's values, or null. */
  const [hover, setHover] = useState<{
    left: number;
    top: number;
    flipX: boolean;
    t: number;
    values: (number | null)[];
  } | null>(null);
  /** Non-zero while any host is showing a down lane; drives the zero baseline. */
  const laneStep = useRef(0);
  /** Axis range computed in build(); the y scale reads it verbatim. */
  const yRange = useRef<[number, number]>([0, 10]);
  /** Y value of the down-lane divider, or null when nothing is failing. */
  const laneDivider = useRef<number | null>(null);

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

    const rank = laneRanks(b.down);

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
    const { range, gap, divider } = withLanes(base, rank.size);
    yRange.current = range;
    laneStep.current = gap;
    laneDivider.current = gap > 0 ? divider : null;

    const { lanes, connectors } = buildLaneSeries(b.ys, b.down, rank, gap, divider);

    return [b.xs, ...b.ys, ...lanes, ...connectors] as uPlot.AlignedData;
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
          // Below the divider is the down-lane band, which is status rather
          // than a measurement, so those ticks carry no label.
          values: (_u, splits) =>
            splits.map((v) =>
              laneDivider.current !== null && v < laneDivider.current ? '' : `${v} ms`,
            ),
        },
      ],
      cursor: { focus: { prox: 24 }, points: { size: 6 } },
      hooks: {
        setSelect: [
          (u) => {
            if (u.select.width > 0) setZoom(true);
          },
        ],
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            // Null while the pointer is off the plot, or mid drag-select where a
            // readout would just be in the way.
            if (idx == null || u.select.width > 0) {
              setHover(null);
              return;
            }
            const dpr = window.devicePixelRatio || 1;
            const left = u.bbox.left / dpr + (u.cursor.left ?? 0);
            const top = u.bbox.top / dpr + (u.cursor.top ?? 0);
            setHover({
              left,
              top,
              flipX: (u.cursor.left ?? 0) > u.bbox.width / dpr / 2,
              t: u.data[0][idx] as number,
              // Latency series only — lanes and connectors follow but are status,
              // not a measurement.
              values: hosts.map((_, i) => (u.data[i + 1]?.[idx] ?? null) as number | null),
            });
          },
        ],
        // Mark the divider, so the lanes below it read as "not responding"
        // rather than as unusually low latency.
        draw: [
          (u) => {
            if (laneDivider.current === null) return;
            const ctx = u.ctx;
            const y = Math.round(u.valToPos(laneDivider.current, 'y', true)) + 0.5;
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
        // Transition connectors: solid, so the exact moment a host drops or
        // recovers is a visible edge rather than a gap between two lines.
        ...hosts.map((h, i) => {
          const style = seriesStyle(i, theme);
          return {
            label: `${h.label} (transition)`,
            stroke: h.color ?? style.stroke,
            width: 1.5,
            spanGaps: false,
            points: { show: false },
          } satisfies uPlot.Series;
        }),
      ],
    };

    const u = new uPlot(opts, build(), el);
    chart.current = u;

    const ro = new ResizeObserver(() => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      // Switching to another tab hides this one with `display: none`, which
      // reports 0x0. Resizing the canvas to nothing and back loses the drawing;
      // ignoring it keeps the last good size until the tab is shown again.
      if (width === 0 || height === 0) return;
      u.setSize({ width, height });
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
  // into the old domain is meaningless. A stale hover readout would point at a
  // bucket that no longer exists, so drop it too — here and when hosts change.
  useEffect(() => {
    setZoom(false);
    setHover(null);
  }, [spanSec, bucketSec]);

  useEffect(() => {
    setHover(null);
  }, [hostKey]);

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
      {hover && (
        <div
          className="pointer-events-none absolute z-10 min-w-[8rem] max-w-[16rem] rounded-md border border-border bg-surface/95 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur"
          style={{
            left: hover.left + (hover.flipX ? -12 : 12),
            top: hover.top,
            transform: `translateY(-50%)${hover.flipX ? ' translateX(-100%)' : ''}`,
          }}
        >
          <div className="mb-1 font-mono text-[11px] text-text-muted">
            {new Date(hover.t * 1000).toLocaleTimeString(undefined, { hour12: false })}
          </div>
          <ul className="space-y-0.5">
            {hosts.map((h, i) => {
              const v = hover.values[i];
              return (
                <li key={h.id} className="flex items-center gap-1.5">
                  <span
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ background: h.color ?? seriesStyle(i, theme).stroke }}
                  />
                  <span className="min-w-0 flex-1 truncate">{h.label}</span>
                  <span className="shrink-0 font-mono tabular-nums">
                    {v == null ? <span className="text-text-muted">no reply</span> : formatMs(v)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
