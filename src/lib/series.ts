/**
 * Aligned time-series storage for the latency chart.
 *
 * uPlot requires "aligned" data: one shared x array, and one y array per series
 * of exactly the same length. Gaps must be `null` — uPlot's gap detection is
 * null-based, and a typed array cannot express that, so the y series are plain
 * arrays. They are handed to uPlot by reference with no per-frame copy.
 */

export type Series = (number | null)[];

export class SeriesStore {
  readonly capacity: number;
  private xs: number[] = [];
  private ys = new Map<string, Series>();
  /**
   * Column index at which each host began being probed.
   *
   * Nulls before this point are back-fill — the host did not exist yet — while
   * nulls at or after it mean a probe that got no reply. Without this the two
   * are indistinguishable, and a host added late would look like it had been
   * down for the entire history.
   */
  private starts = new Map<string, number>();

  /** @param capacity maximum samples retained per series */
  constructor(capacity = 3600) {
    this.capacity = capacity;
  }

  get length(): number {
    return this.xs.length;
  }

  get hostIds(): string[] {
    return [...this.ys.keys()];
  }

  /**
   * Registers a host. Back-fills nulls so the new series stays aligned with
   * existing ones rather than being shorter and silently misrendering.
   */
  addHost(id: string): void {
    if (this.ys.has(id)) return;
    this.ys.set(id, new Array<number | null>(this.xs.length).fill(null));
    this.starts.set(id, this.xs.length);
  }

  removeHost(id: string): void {
    this.ys.delete(id);
    this.starts.delete(id);
  }

  /** First column at which this host was being probed. */
  startIndex(id: string): number {
    return this.starts.get(id) ?? 0;
  }

  /**
   * Appends one sample column.
   *
   * @param tSec  timestamp in seconds (uPlot's time scale unit)
   * @param values latency in ms per host; any host absent from the map, or
   *               mapped to null, becomes a gap
   */
  push(tSec: number, values: Map<string, number | null>): void {
    this.xs.push(tSec);

    for (const [id, series] of this.ys) {
      series.push(values.get(id) ?? null);
    }

    // Any host seen for the first time joins back-filled and aligned.
    for (const id of values.keys()) {
      if (!this.ys.has(id)) {
        const series = new Array<number | null>(this.xs.length - 1).fill(null);
        series.push(values.get(id) ?? null);
        this.ys.set(id, series);
        this.starts.set(id, this.xs.length - 1);
      }
    }

    if (this.xs.length > this.capacity) {
      this.xs.shift();
      for (const series of this.ys.values()) series.shift();
      // Every start index shifts down with the window.
      for (const [id, at] of this.starts) this.starts.set(id, Math.max(0, at - 1));
    }
  }

  /** The series for one host, or undefined if unknown. */
  series(id: string): Series | undefined {
    return this.ys.get(id);
  }

  /**
   * Data in uPlot's AlignedData shape: `[xs, ...ySeries]`, ordered to match
   * `hostIds`. Unknown ids yield an all-null series so the chart's series
   * configuration and data never disagree on length.
   */
  aligned(hostIds: string[]): [number[], ...Series[]] {
    const out: Series[] = hostIds.map(
      (id) => this.ys.get(id) ?? new Array<number | null>(this.xs.length).fill(null),
    );
    return [this.xs, ...out];
  }

  clear(): void {
    this.xs = [];
    this.ys.clear();
    this.starts.clear();
  }
}
