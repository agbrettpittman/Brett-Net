import { describe, expect, it } from 'vitest';
import { CONTINUITY_SEC, latencyMs, toColumns } from './backfill';
import type { HistorySample } from './ipc';
import { SeriesStore } from './series';

function sample(t: number, hostId: string, rttUs: number | null, status = 'success'): HistorySample {
  return { t, hostId, rttUs, status: status as HistorySample['status'] };
}

describe('latencyMs', () => {
  it('converts a successful reply to milliseconds', () => {
    expect(latencyMs('success', 12_345)).toBeCloseTo(12.345);
  });

  it('treats anything other than a reply from the target as a gap', () => {
    expect(latencyMs('timedOut', null)).toBeNull();
    expect(latencyMs('dnsFailure', null)).toBeNull();
    // A TTL-expired reply carries a real round trip, but it came from a router
    // in between — plotting it as the host's latency would be wrong.
    expect(latencyMs('ttlExpired', 5000)).toBeNull();
  });
});

describe('toColumns', () => {
  it('returns nothing for an empty history', () => {
    expect(toColumns([], 100)).toEqual([]);
  });

  it('groups samples sharing a timestamp into one column', () => {
    const cols = toColumns(
      [sample(1000, 'a', 1000), sample(1000, 'b', 2000), sample(2000, 'a', 3000)],
      100,
    );
    expect(cols).toHaveLength(2);
    expect(cols[0]!.tSec).toBe(1);
    expect(cols[0]!.values.get('a')).toBe(1);
    expect(cols[0]!.values.get('b')).toBe(2);
    expect(cols[1]!.values.get('a')).toBe(3);
  });

  it('orders columns oldest first even if the rows are not sorted', () => {
    const cols = toColumns([sample(3000, 'a', 1000), sample(1000, 'a', 1000)], 100);
    expect(cols.map((c) => c.tSec)).toEqual([1, 3]);
  });

  it('records a failure as null rather than dropping the column', () => {
    const cols = toColumns([sample(1000, 'a', null, 'timedOut')], 100);
    expect(cols).toHaveLength(1);
    expect(cols[0]!.values.get('a')).toBeNull();
    // The key must be present: an absent host is back-fill, a null is a failure.
    expect(cols[0]!.values.has('a')).toBe(true);
  });

  it('keeps only the newest run when there is a long break', () => {
    const day = 86_400_000;
    const cols = toColumns(
      [
        sample(0, 'a', 1000),
        sample(1000, 'a', 1000),
        // App was closed for a day.
        sample(day, 'a', 1000),
        sample(day + 1000, 'a', 1000),
      ],
      100,
    );
    expect(cols.map((c) => c.tSec)).toEqual([day / 1000, day / 1000 + 1]);
  });

  it('joins across a short break, so a restart is seamless', () => {
    const gap = (CONTINUITY_SEC - 10) * 1000;
    const cols = toColumns(
      [sample(0, 'a', 1000), sample(gap, 'a', 1000), sample(gap + 1000, 'a', 1000)],
      100,
    );
    expect(cols).toHaveLength(3);
  });

  it('cuts at the most recent break, not the first one', () => {
    const hour = 3_600_000;
    const cols = toColumns(
      [
        sample(0, 'a', 1000),
        sample(hour, 'a', 1000),
        sample(2 * hour, 'a', 1000),
        sample(2 * hour + 1000, 'a', 1000),
      ],
      100,
    );
    expect(cols.map((c) => c.tSec)).toEqual([2 * 3600, 2 * 3600 + 1]);
  });

  it('keeps the newest columns when capped', () => {
    const samples = Array.from({ length: 10 }, (_, i) => sample(i * 1000, 'a', 1000));
    expect(toColumns(samples, 3).map((c) => c.tSec)).toEqual([7, 8, 9]);
  });

  it('returns nothing when the cap is zero', () => {
    expect(toColumns([sample(0, 'a', 1000)], 0)).toEqual([]);
  });
});

describe('back-filling a SeriesStore', () => {
  it('replays into a store that then accepts live samples in order', () => {
    const store = new SeriesStore(100);
    for (const col of toColumns(
      [sample(1000, 'a', 1000), sample(2000, 'a', 2000), sample(2000, 'b', 3000)],
      100,
    )) {
      store.push(col.tSec, col.values);
    }
    store.push(3, new Map([['a', 4]]));

    expect(store.length).toBe(3);
    expect(store.series('a')).toEqual([1, 2, 4]);
    // 'b' first appeared in the second column, so its earlier slot is back-fill.
    expect(store.series('b')).toEqual([null, 3, null]);
    expect(store.startIndex('b')).toBe(1);
  });

  it('leaves a host with no history starting at the live edge', () => {
    const store = new SeriesStore(100);
    for (const col of toColumns([sample(1000, 'a', 1000)], 100)) {
      store.push(col.tSec, col.values);
    }
    // A host added after the restore has no stored samples at all.
    store.addHost('new');

    expect(store.startIndex('new')).toBe(1);
    expect(store.series('new')).toEqual([null]);
  });
});
