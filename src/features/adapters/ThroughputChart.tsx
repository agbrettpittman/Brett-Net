import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { SeriesStore } from '../../lib/series';
import { chartTheme } from '../../lib/palette';
import { formatRateTick, niceCeil, stackSeries } from '../../lib/traffic';

/** One interface to draw, with the colour pair its card carries. */
export interface ChartInterface {
  luid: string;
  name: string;
  received: string;
  sent: string;
}

interface Props {
  store: SeriesStore;
  interfaces: ChartInterface[];
  /** Series keys, kept in step with how the parent stores samples. */
  inKey: (luid: string) => string;
  outKey: (luid: string) => string;
  theme: string;
  /** Bumped by the parent on each new sample; drives the redraw. */
  revision: number;
}

/** Smallest axis extent, so an idle interface is not scaled to a few bits. */
const FLOOR_BPS = 10_000;

/**
 * Throughput as stacked areas: received above the line, sent below.
 *
 * Splitting the two directions is what makes a busy upload visible underneath a
 * busy download instead of hidden by it. The sign is only a drawing device —
 * the axis labels are absolute.
 *
 * Each interface gets one hue, with the lighter of its pair used for sent, so
 * direction is legible from the colour and not only from which half of the
 * chart a band is in.
 *
 * **The fills are opaque on purpose.** Each band is drawn as a cumulative total
 * filled to zero, with the band above drawn first and each lower one painted
 * over it. A translucent fill would blend with the band underneath, so the
 * colours on screen would not be the colours in the legend.
 */
export function ThroughputChart({ store, interfaces, inKey, outKey, theme, revision }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<uPlot | null>(null);
  /** Axis extent in bits/sec, recomputed in build(); the scale reads it. */
  const peak = useRef(FLOOR_BPS);

  // Rebuild only when the shape changes, not on every sample.
  const shape = interfaces.map((i) => `${i.luid}:${i.received}:${i.sent}`).join('|');

  function build(): uPlot.AlignedData {
    const keys = [
      ...interfaces.map((i) => inKey(i.luid)),
      ...interfaces.map((i) => outKey(i.luid)),
    ];
    const [xs, ...all] = store.aligned(keys);

    const received = stackSeries(all.slice(0, interfaces.length));
    // Negated before stacking, so the running total grows downwards.
    const sent = stackSeries(
      all.slice(interfaces.length).map((s) => s.map((v) => (v == null ? null : -v))),
    );

    // The outermost cumulative series is the total, so it alone sets the extent.
    let highest = FLOOR_BPS;
    for (const series of [received.at(-1), sent.at(-1)]) {
      for (const v of series ?? []) {
        if (v != null && Math.abs(v) > highest) highest = Math.abs(v);
      }
    }
    peak.current = niceCeil(highest);

    // Reversed: uPlot paints in array order, so the largest total goes down
    // first and each smaller one covers its lower part, leaving the bands.
    return [xs, ...received.reverse(), ...sent.reverse()] as uPlot.AlignedData;
  }

  useEffect(() => {
    const el = container.current;
    if (!el) return;

    const colors = chartTheme(theme);
    // Matches the reversal in build().
    const painted = [...interfaces].reverse();

    const area = (i: ChartInterface, direction: 'received' | 'sent') =>
      ({
        label: `${i.name} ${direction}`,
        stroke: i[direction],
        fill: i[direction],
        width: 1,
        spanGaps: false,
        points: { show: false },
      }) satisfies uPlot.Series;

    const u = new uPlot(
      {
        width: el.clientWidth || 800,
        height: el.clientHeight || 200,
        legend: { show: false },
        padding: [10, 12, 0, 0],
        scales: {
          x: { time: true },
          // Symmetric, so the zero line sits in the middle and a quiet
          // direction does not get a squashed half.
          y: { range: () => [-peak.current, peak.current] },
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
            // Fixed rather than left to uPlot: the range moves every second, and
            // letting it choose gave a step wider than the range itself, so
            // every tick but zero fell outside the plot.
            splits: () => {
              const p = peak.current;
              return [-p, -p / 2, 0, p / 2, p];
            },
            // Absolute: the lower half is "sent", not a negative quantity.
            values: (_u, splits) => splits.map((v) => formatRateTick(Math.abs(v))),
          },
        ],
        cursor: { focus: { prox: 24 }, points: { size: 6 } },
        hooks: {
          draw: [
            (instance) => {
              // Mark zero, so up and down read as separate halves.
              const ctx = instance.ctx;
              const y = Math.round(instance.valToPos(0, 'y', true)) + 0.5;
              ctx.save();
              ctx.beginPath();
              ctx.setLineDash([]);
              ctx.strokeStyle = colors.axis;
              ctx.globalAlpha = 0.6;
              ctx.lineWidth = 1;
              ctx.moveTo(instance.bbox.left, y);
              ctx.lineTo(instance.bbox.left + instance.bbox.width, y);
              ctx.stroke();
              ctx.restore();
            },
          ],
        },
        series: [
          {},
          ...painted.map((i) => area(i, 'received')),
          ...painted.map((i) => area(i, 'sent')),
        ],
      },
      build(),
      el,
    );
    chart.current = u;

    const ro = new ResizeObserver(() => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      // A hidden tab reports 0x0; resizing to nothing loses the drawing.
      if (width === 0 || height === 0) return;
      u.setSize({ width, height });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      u.destroy();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, theme]);

  useEffect(() => {
    chart.current?.setData(build(), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, shape]);

  return (
    // The legend is a row of its own rather than an overlay: a busy interface
    // fills the top of the plot, and anything floating there gets buried under
    // exactly the traffic you were trying to identify.
    <div className="flex h-full w-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-0.5 px-2 pb-1 text-xs">
        {interfaces.map((i) => (
          <span key={i.luid} className="flex items-center gap-1">
            <DirectionSwatch received={i.received} sent={i.sent} />
            {i.name}
          </span>
        ))}
        <span className="text-text-muted">lighter = sent · bits/sec</span>
      </div>
      <div ref={container} className="min-h-0 w-full flex-1" />
    </div>
  );
}

/**
 * Both of an interface's colours in one square, stacked the way the chart
 * stacks them: received on top, sent below.
 */
export function DirectionSwatch({ received, sent }: { received: string; sent: string }) {
  return (
    <span
      className="inline-block size-2.5 shrink-0 rounded-sm"
      style={{ background: `linear-gradient(to bottom, ${received} 50%, ${sent} 50%)` }}
      aria-hidden
    />
  );
}
