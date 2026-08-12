import { describe, expect, it } from 'vitest';
import { buildLaneSeries, laneRanks, laneY } from './lanes';

const GAP = 10;

describe('laneRanks', () => {
  it('ignores hosts that never failed', () => {
    expect(laneRanks([[false, false]]).size).toBe(0);
  });

  it('ranks failing hosts in order, skipping healthy ones', () => {
    const r = laneRanks([[false], [true], [false], [true]]);
    expect([...r.entries()]).toEqual([
      [1, 0],
      [3, 1],
    ]);
  });
});

describe('laneY', () => {
  it('stacks downward and never touches zero', () => {
    expect(laneY(0, GAP, 0)).toBe(-10);
    expect(laneY(1, GAP, 0)).toBe(-20);
    expect(laneY(0, GAP, 0)).toBeLessThan(0);
  });
});

describe('buildLaneSeries', () => {
  function build(ys: (number | null)[], down: boolean[]) {
    const ranks = laneRanks([down]);
    const r = buildLaneSeries([ys], [down], ranks, GAP, 0);
    return { lane: r.lanes[0]!, conn: r.connectors[0]! };
  }

  it('leaves a healthy host entirely empty but correctly sized', () => {
    const { lane, conn } = build([10, 20, 30], [false, false, false]);
    expect(lane).toEqual([null, null, null]);
    expect(conn).toEqual([null, null, null]);
  });

  it('fills the lane while down', () => {
    const { lane } = build([null, null, 30], [true, true, false]);
    expect(lane).toEqual([-10, -10, null]);
  });

  it('bridges recovery from the lane to the first good sample', () => {
    const { conn } = build([null, null, 30, 31], [true, true, false, false]);
    // The segment spans the last down bucket and the first reachable one.
    expect(conn).toEqual([null, -10, 30, null]);
  });

  it('bridges a host going down', () => {
    const { conn } = build([30, 31, null, null], [false, false, true, true]);
    expect(conn).toEqual([null, 31, -10, null]);
  });

  it('bridges every transition when a host is flapping', () => {
    // up, down, up, down, up — every adjacent pair is a transition
    const { conn } = build([10, null, 12, null, 14], [false, true, false, true, false]);
    expect(conn).toEqual([10, -10, 12, -10, 14]);
  });

  it('does not bridge across a hole in the data', () => {
    // Middle bucket is neither down nor measured: nothing to connect to.
    const { conn } = build([10, null, 30], [false, false, false]);
    expect(conn).toEqual([null, null, null]);
  });

  it('does not bridge when the state never changes', () => {
    expect(build([null, null], [true, true]).conn).toEqual([null, null]);
    expect(build([10, 20], [false, false]).conn).toEqual([null, null]);
  });

  it('keeps every series the same length as its input', () => {
    const ys = [[1, null, 3], [null, null, null]];
    const down = [[false, true, false], [true, true, true]];
    const r = buildLaneSeries(ys, down, laneRanks(down), GAP, 0);
    for (const s of [...r.lanes, ...r.connectors]) expect(s).toHaveLength(3);
  });

  it('places each failing host in its own lane', () => {
    const ys = [[null, null], [null, null]];
    const down = [[true, true], [true, true]];
    const r = buildLaneSeries(ys, down, laneRanks(down), GAP, 0);
    expect(r.lanes[0]).toEqual([-10, -10]);
    expect(r.lanes[1]).toEqual([-20, -20]);
  });
});
