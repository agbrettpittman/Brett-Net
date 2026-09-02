/** Which ping-table column the rows are ordered by. */
export type HostSortKey = 'host' | 'target' | 'last' | 'avg' | 'jitter' | 'loss';

export interface HostSortState {
  key: HostSortKey;
  dir: 'asc' | 'desc';
}

/** The fields a row must expose to be sortable. `null` means "no data yet". */
export interface HostSortRow {
  label: string;
  target: string;
  last: number | null;
  avg: number | null;
  jitter: number | null;
  lossPct: number | null;
}

const TEXT_KEYS: ReadonlySet<HostSortKey> = new Set(['host', 'target']);

/**
 * Header-click cycle: unsorted → ascending → descending → unsorted.
 *
 * The third click clears the sort rather than looping back to ascending, so a
 * column can always be returned to the chart's own line order without a
 * separate control.
 */
export function nextSort(prev: HostSortState | null, key: HostSortKey): HostSortState | null {
  if (prev?.key !== key) return { key, dir: 'asc' };
  return prev.dir === 'asc' ? { key, dir: 'desc' } : null;
}

function field(row: HostSortRow, key: HostSortKey): string | number | null {
  switch (key) {
    case 'host':
      return row.label;
    case 'target':
      return row.target;
    case 'last':
      return row.last;
    case 'avg':
      return row.avg;
    case 'jitter':
      return row.jitter;
    case 'loss':
      return row.lossPct;
  }
}

/**
 * Orders rows for display without mutating the input.
 *
 * A `null` sort returns the rows untouched, which is the order the chart draws
 * its lines in. Rows with no data yet always sink to the bottom whichever
 * direction is chosen — a blank row floating to the top of a descending sort is
 * just noise. Ties keep their original order (`Array.prototype.sort` is stable),
 * so equal rows still line up with the chart.
 */
export function sortRows<T extends HostSortRow>(rows: T[], sort: HostSortState | null): T[] {
  if (!sort) return rows;

  const mul = sort.dir === 'asc' ? 1 : -1;
  const text = TEXT_KEYS.has(sort.key);

  return [...rows].sort((a, b) => {
    const av = field(a, sort.key);
    const bv = field(b, sort.key);

    if (text) {
      return mul * String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' });
    }

    // Numeric: missing values are pinned last regardless of direction.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return mul * ((av as number) - (bv as number));
  });
}
