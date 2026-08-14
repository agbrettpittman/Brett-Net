import { describe, expect, it } from 'vitest';
import {
  accumulate,
  formatBytes,
  formatRate,
  formatRateTick,
  MAX_ELAPSED_SEC,
  niceCeil,
  stackSeries,
  throughput,
  type CounterSample,
  type Totals,
} from './traffic';

const sample = (t: number, ...rows: [string, number, number][]): CounterSample => ({
  t,
  interfaces: rows.map(([luid, inOctets, outOctets]) => ({
    luid,
    name: `if-${luid}`,
    inOctets,
    outOctets,
  })),
});

describe('throughput', () => {
  it('needs two reads, because one is a total not a rate', () => {
    expect(throughput(null, sample(1000, ['a', 100, 100]))).toEqual([]);
  });

  it('converts bytes per interval into bits per second', () => {
    // 1000 bytes over one second is 8000 bits per second.
    const got = throughput(sample(1000, ['a', 0, 0]), sample(2000, ['a', 1000, 500]));
    expect(got).toEqual([{ luid: 'a', name: 'if-a', inBps: 8000, outBps: 4000 }]);
  });

  it('scales by the real elapsed time, not the intended interval', () => {
    // A late sample must not read as a burst.
    const got = throughput(sample(0, ['a', 0, 0]), sample(4000, ['a', 4000, 0]));
    expect(got[0]!.inBps).toBe(8000);
  });

  it('treats a counter that went backwards as a reset, not a negative rate', () => {
    // Disabling and re-enabling an adapter zeroes it; subtracting would produce
    // a huge negative number and wreck the chart's scale.
    const got = throughput(sample(0, ['a', 999_999, 999_999]), sample(1000, ['a', 10, 0]));
    expect(got[0]!.inBps).toBe(0);
    expect(got[0]!.outBps).toBe(0);
  });

  it('ignores an interface it has not seen before', () => {
    const got = throughput(sample(0, ['a', 0, 0]), sample(1000, ['a', 100, 0], ['b', 5000, 0]));
    expect(got.map((r) => r.luid)).toEqual(['a']);
  });

  it('produces nothing when the clock did not advance', () => {
    expect(throughput(sample(1000, ['a', 0, 0]), sample(1000, ['a', 500, 0]))).toEqual([]);
  });

  it('produces nothing when the clock went backwards', () => {
    // An NTP step, which would otherwise divide by a negative number.
    expect(throughput(sample(5000, ['a', 0, 0]), sample(1000, ['a', 500, 0]))).toEqual([]);
  });

  it('produces nothing across a gap longer than the cutoff', () => {
    // A suspended laptop. Averaging an hour of traffic over an hour would draw
    // a flat bar as though that had been the rate the whole time.
    const long = (MAX_ELAPSED_SEC + 1) * 1000;
    expect(throughput(sample(0, ['a', 0, 0]), sample(long, ['a', 1e9, 0]))).toEqual([]);
  });

  it('still reports right up to the cutoff', () => {
    const edge = MAX_ELAPSED_SEC * 1000;
    expect(throughput(sample(0, ['a', 0, 0]), sample(edge, ['a', 1000, 0]))).toHaveLength(1);
  });
});

describe('accumulate', () => {
  const empty: Totals = new Map();

  it('adds each interval to a running byte total', () => {
    let totals = accumulate(empty, sample(0, ['a', 100, 50]), sample(1000, ['a', 400, 150]));
    totals = accumulate(totals, sample(1000, ['a', 400, 150]), sample(2000, ['a', 500, 200]));
    expect(totals.get('a')).toEqual({ inBytes: 400, outBytes: 150 });
  });

  it('counts traffic across a long gap, unlike the rate', () => {
    // The bytes really did cross the wire while the machine was asleep, even
    // though they make no sense as an instantaneous rate.
    const long = (MAX_ELAPSED_SEC + 60) * 1000;
    const totals = accumulate(empty, sample(0, ['a', 0, 0]), sample(long, ['a', 5_000, 0]));
    expect(totals.get('a')?.inBytes).toBe(5_000);
    expect(throughput(sample(0, ['a', 0, 0]), sample(long, ['a', 5_000, 0]))).toEqual([]);
  });

  it('does not go backwards when a counter resets', () => {
    let totals = accumulate(empty, sample(0, ['a', 0, 0]), sample(1000, ['a', 900, 0]));
    totals = accumulate(totals, sample(1000, ['a', 900, 0]), sample(2000, ['a', 5, 0]));
    expect(totals.get('a')?.inBytes).toBe(900);
  });

  it('leaves the totals alone without an earlier read', () => {
    expect(accumulate(empty, null, sample(0, ['a', 100, 0]))).toBe(empty);
  });

  it('does not mutate the map it was given', () => {
    const before: Totals = new Map();
    accumulate(before, sample(0, ['a', 0, 0]), sample(1000, ['a', 100, 0]));
    expect(before.size).toBe(0);
  });
});

describe('formatRate', () => {
  it('uses the unit a link speed is quoted in', () => {
    expect(formatRate(0)).toBe('0 bps');
    expect(formatRate(940)).toBe('940 bps');
    expect(formatRate(8000)).toBe('8 Kbps');
    expect(formatRate(4.2e6)).toBe('4.2 Mbps');
    expect(formatRate(2.5e9)).toBe('2.50 Gbps');
  });

  it('survives nonsense rather than printing NaN', () => {
    expect(formatRate(NaN)).toBe('0 bps');
    expect(formatRate(Infinity)).toBe('0 bps');
    expect(formatRate(-5)).toBe('0 bps');
  });
});

describe('formatBytes', () => {
  it('uses binary units, matching Task Manager', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(1024 * 1024 * 20)).toBe('20.0 MB');
    expect(formatBytes(1024 ** 3 * 3.5)).toBe('3.50 GB');
  });

  it('stops at the largest unit it knows', () => {
    expect(formatBytes(1024 ** 6)).toMatch(/TB$/);
  });
});

describe('stackSeries', () => {
  it('makes each series the running total of those before it', () => {
    expect(
      stackSeries([
        [1, 2],
        [10, 20],
        [100, 200],
      ]),
    ).toEqual([
      [1, 2],
      [11, 22],
      [111, 222],
    ]);
  });

  it('counts a missing value as zero rather than breaking the stack', () => {
    // An idle interface contributes an empty band; the ones above it must not
    // get a hole punched through them.
    expect(
      stackSeries([
        [5, null],
        [3, 4],
      ]),
    ).toEqual([
      [5, 0],
      [8, 4],
    ]);
  });

  it('keeps a column null when every series is missing', () => {
    // A genuine gap in the data still reads as a gap.
    expect(
      stackSeries([
        [1, null],
        [2, null],
      ]),
    ).toEqual([
      [1, null],
      [3, null],
    ]);
  });

  it('stacks negatives away from zero, for the sent half', () => {
    expect(
      stackSeries([
        [-1, -2],
        [-10, -20],
      ]),
    ).toEqual([
      [-1, -2],
      [-11, -22],
    ]);
  });

  it('handles a single series and no series at all', () => {
    expect(stackSeries([[1, 2]])).toEqual([[1, 2]]);
    expect(stackSeries([])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [
      [1, 1],
      [2, 2],
    ];
    stackSeries(input);
    expect(input).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});

describe('niceCeil', () => {
  it('rounds up to 1, 2 or 5 times a power of ten', () => {
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1.5)).toBe(2);
    expect(niceCeil(3)).toBe(5);
    expect(niceCeil(6)).toBe(10);
    expect(niceCeil(28.4e6)).toBe(50e6);
    expect(niceCeil(4e6)).toBe(5e6);
    expect(niceCeil(10e6)).toBe(10e6);
  });

  it('never returns something smaller than it was given', () => {
    // The axis extent must contain the data, or the line is clipped.
    for (const v of [1, 7, 99, 12_345, 3.2e6, 8.8e9]) {
      expect(niceCeil(v), String(v)).toBeGreaterThanOrEqual(v);
    }
  });

  it('degrades to 1 rather than 0 or NaN', () => {
    // A zero extent would make the scale collapse.
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(niceCeil(bad), String(bad)).toBe(1);
    }
  });
});

describe('formatRateTick', () => {
  it('stays short enough for an axis', () => {
    expect(formatRateTick(0)).toBe('0');
    expect(formatRateTick(12_000)).toBe('12k');
    expect(formatRateTick(4.25e6)).toBe('4.3M');
    expect(formatRateTick(2e9)).toBe('2G');
  });
});
