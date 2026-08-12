import type { Series } from './series';

export interface LaneSeries {
  /** Dashed status line below zero; null wherever the host was reachable. */
  lanes: Series[];
  /**
   * Solid segments bridging the down-lane and the latency line at each state
   * change, so the exact moment of failure and recovery is visible instead of
   * being an ambiguous gap between two disconnected lines.
   */
  connectors: Series[];
}

/**
 * Assigns a lane index to each series that is failing somewhere in view.
 *
 * Only failing hosts get a lane, in host order, so the band stays compact
 * rather than reserving depth for every host on the chart.
 */
export function laneRanks(down: boolean[][]): Map<number, number> {
  const ranks = new Map<number, number>();
  down.forEach((d, i) => {
    if (d.some(Boolean)) ranks.set(i, ranks.size);
  });
  return ranks;
}

/** Lane `rank` hangs `gap` below the previous one, starting under `divider`. */
export function laneY(rank: number, gap: number, divider: number): number {
  return divider - gap * (rank + 1);
}

export function buildLaneSeries(
  ys: Series[],
  down: boolean[][],
  ranks: Map<number, number>,
  gap: number,
  divider: number,
): LaneSeries {
  const lanes: Series[] = [];
  const connectors: Series[] = [];

  ys.forEach((s, i) => {
    const rank = ranks.get(i);
    if (rank === undefined) {
      // Never failed in view: both series stay empty but must keep their length
      // so the chart's data stays aligned.
      lanes.push(s.map(() => null));
      connectors.push(s.map(() => null));
      return;
    }

    const y = laneY(rank, gap, divider);
    const d = down[i] ?? [];

    // Where the host "is" at each bucket: down in its lane, or up at its latency.
    const merged = s.map((v, j) => (d[j] ? y : v));

    lanes.push(merged.map((v, j) => (d[j] ? v : null)));

    const conn: Series = merged.map(() => null);
    for (let j = 0; j + 1 < merged.length; j++) {
      const a = merged[j];
      const b = merged[j + 1];
      // Both ends must exist, and the state must actually change. A null is a
      // hole in the data, not a transition, so it never gets bridged.
      if (a == null || b == null) continue;
      if (!!d[j] === !!d[j + 1]) continue;
      conn[j] = a;
      conn[j + 1] = b;
    }
    connectors.push(conn);
  });

  return { lanes, connectors };
}
