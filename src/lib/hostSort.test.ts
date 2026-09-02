import { describe, expect, it } from 'vitest';
import { nextSort, sortRows, type HostSortRow, type HostSortState } from './hostSort';

function row(label: string, over: Partial<HostSortRow> = {}): HostSortRow {
  return { label, target: label, last: null, avg: null, jitter: null, lossPct: null, ...over };
}

const labels = (rows: HostSortRow[]) => rows.map((r) => r.label);

describe('nextSort', () => {
  it('starts a fresh column ascending', () => {
    expect(nextSort(null, 'avg')).toEqual({ key: 'avg', dir: 'asc' });
    expect(nextSort({ key: 'host', dir: 'desc' }, 'avg')).toEqual({ key: 'avg', dir: 'asc' });
  });

  it('cycles asc → desc → off on the same column', () => {
    let s: HostSortState | null = null;
    s = nextSort(s, 'last');
    expect(s).toEqual({ key: 'last', dir: 'asc' });
    s = nextSort(s, 'last');
    expect(s).toEqual({ key: 'last', dir: 'desc' });
    s = nextSort(s, 'last');
    expect(s).toBeNull();
  });
});

describe('sortRows', () => {
  it('leaves rows untouched when unsorted', () => {
    const rows = [row('b'), row('a'), row('c')];
    expect(sortRows(rows, null)).toBe(rows);
  });

  it('does not mutate the input', () => {
    const rows = [row('b'), row('a')];
    sortRows(rows, { key: 'host', dir: 'asc' });
    expect(labels(rows)).toEqual(['b', 'a']);
  });

  it('sorts text case-insensitively in both directions', () => {
    const rows = [row('Charlie'), row('alpha'), row('Bravo')];
    expect(labels(sortRows(rows, { key: 'host', dir: 'asc' }))).toEqual(['alpha', 'Bravo', 'Charlie']);
    expect(labels(sortRows(rows, { key: 'host', dir: 'desc' }))).toEqual(['Charlie', 'Bravo', 'alpha']);
  });

  it('sorts numeric columns', () => {
    const rows = [
      row('slow', { avg: 120 }),
      row('fast', { avg: 8 }),
      row('mid', { avg: 40 }),
    ];
    expect(labels(sortRows(rows, { key: 'avg', dir: 'asc' }))).toEqual(['fast', 'mid', 'slow']);
    expect(labels(sortRows(rows, { key: 'avg', dir: 'desc' }))).toEqual(['slow', 'mid', 'fast']);
  });

  it('pins no-data rows to the bottom whichever direction', () => {
    const rows = [row('none'), row('has', { last: 25 }), row('none2')];
    expect(labels(sortRows(rows, { key: 'last', dir: 'asc' }))).toEqual(['has', 'none', 'none2']);
    expect(labels(sortRows(rows, { key: 'last', dir: 'desc' }))).toEqual(['has', 'none', 'none2']);
  });

  it('keeps equal rows in their original order', () => {
    const rows = [
      row('first', { lossPct: 0 }),
      row('second', { lossPct: 0 }),
      row('third', { lossPct: 0 }),
    ];
    expect(labels(sortRows(rows, { key: 'loss', dir: 'desc' }))).toEqual(['first', 'second', 'third']);
  });

  it('handles an empty list', () => {
    expect(sortRows([], { key: 'avg', dir: 'asc' })).toEqual([]);
  });
});
