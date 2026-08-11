import { describe, expect, it } from 'vitest';
import { SeriesStore } from './series';

const vals = (o: Record<string, number | null>) => new Map(Object.entries(o));

describe('SeriesStore', () => {
  it('starts empty', () => {
    const s = new SeriesStore();
    expect(s.length).toBe(0);
    expect(s.aligned([])).toEqual([[]]);
  });

  it('appends aligned columns', () => {
    const s = new SeriesStore();
    s.addHost('a');
    s.addHost('b');
    s.push(1, vals({ a: 10, b: 20 }));
    s.push(2, vals({ a: 11, b: 21 }));

    expect(s.aligned(['a', 'b'])).toEqual([
      [1, 2],
      [10, 11],
      [20, 21],
    ]);
  });

  it('records a gap for a host that did not report', () => {
    const s = new SeriesStore();
    s.addHost('a');
    s.addHost('b');
    s.push(1, vals({ a: 10, b: 20 }));
    s.push(2, vals({ a: 11 })); // b missing

    expect(s.series('b')).toEqual([20, null]);
  });

  it('treats an explicit null as a gap', () => {
    const s = new SeriesStore();
    s.addHost('a');
    s.push(1, vals({ a: null }));
    expect(s.series('a')).toEqual([null]);
  });

  it('keeps every series the same length as x', () => {
    const s = new SeriesStore();
    s.addHost('a');
    s.push(1, vals({ a: 1 }));
    s.push(2, vals({ a: 2, b: 5 })); // b appears late
    s.push(3, vals({ a: 3, b: 6 }));

    const [xs, ...series] = s.aligned(['a', 'b']);
    expect(xs).toHaveLength(3);
    for (const y of series) expect(y).toHaveLength(3);
  });

  it('back-fills a late-joining host with nulls', () => {
    const s = new SeriesStore();
    s.addHost('a');
    s.push(1, vals({ a: 1 }));
    s.push(2, vals({ a: 2, b: 5 }));

    expect(s.series('b')).toEqual([null, 5]);
  });

  it('back-fills a host added via addHost after data exists', () => {
    const s = new SeriesStore();
    s.addHost('a');
    s.push(1, vals({ a: 1 }));
    s.push(2, vals({ a: 2 }));
    s.addHost('c');

    expect(s.series('c')).toEqual([null, null]);
  });

  it('evicts the oldest sample past capacity, in step across all series', () => {
    const s = new SeriesStore(3);
    s.addHost('a');
    s.addHost('b');
    for (let i = 1; i <= 5; i++) s.push(i, vals({ a: i, b: i * 10 }));

    const [xs, a, b] = s.aligned(['a', 'b']);
    expect(xs).toEqual([3, 4, 5]);
    expect(a).toEqual([3, 4, 5]);
    expect(b).toEqual([30, 40, 50]);
  });

  it('returns an aligned all-null series for an unknown host', () => {
    const s = new SeriesStore();
    s.addHost('a');
    s.push(1, vals({ a: 1 }));

    const [xs, , ghost] = s.aligned(['a', 'ghost']);
    expect(ghost).toEqual([null]);
    expect(ghost).toHaveLength(xs.length);
  });

  it('drops a removed host but leaves the rest intact', () => {
    const s = new SeriesStore();
    s.addHost('a');
    s.addHost('b');
    s.push(1, vals({ a: 1, b: 2 }));
    s.removeHost('b');

    expect(s.hostIds).toEqual(['a']);
    expect(s.series('b')).toBeUndefined();
    expect(s.series('a')).toEqual([1]);
  });

  it('clears everything', () => {
    const s = new SeriesStore();
    s.addHost('a');
    s.push(1, vals({ a: 1 }));
    s.clear();
    expect(s.length).toBe(0);
    expect(s.hostIds).toEqual([]);
  });
});
