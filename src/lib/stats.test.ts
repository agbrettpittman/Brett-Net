import { describe, expect, it } from 'vitest';
import { HostStats, formatMs } from './stats';
import type { PingResult, PingStatus } from './ipc';

function result(rttUs: number | null, status: PingStatus = 'success'): PingResult {
  return { hostId: 'h', rttUs, status, from: null };
}

describe('HostStats', () => {
  it('starts empty', () => {
    const s = new HostStats();
    expect(s.avg).toBeNull();
    expect(s.jitter).toBeNull();
    expect(s.last).toBeNull();
    expect(s.lossPct).toBe(0);
  });

  it('averages only successful probes', () => {
    const s = new HostStats();
    s.add(result(10_000)); // 10ms
    s.add(result(20_000)); // 20ms
    expect(s.avg).toBe(15);
  });

  it('excludes timeouts from latency but counts them as loss', () => {
    const s = new HostStats();
    s.add(result(10_000));
    s.add(result(null, 'timedOut'));
    s.add(result(20_000));

    // A timeout must not be averaged in as zero.
    expect(s.avg).toBe(15);
    expect(s.sent).toBe(3);
    expect(s.lost).toBe(1);
    expect(s.lossPct).toBeCloseTo(33.33, 1);
  });

  it('treats a non-success status as loss even if an RTT is present', () => {
    // TTL-expired replies carry a measured RTT, but they are not a reachable host.
    const s = new HostStats();
    s.add(result(5_000, 'ttlExpired'));
    expect(s.lost).toBe(1);
    expect(s.avg).toBeNull();
  });

  it('clears last on a failed probe so the UI cannot show a stale value', () => {
    const s = new HostStats();
    s.add(result(10_000));
    expect(s.last).toBe(10);
    s.add(result(null, 'timedOut'));
    expect(s.last).toBeNull();
  });

  it('tracks min and max across all successes', () => {
    const s = new HostStats();
    for (const v of [30_000, 10_000, 50_000, 20_000]) s.add(result(v));
    expect(s.min).toBe(10);
    expect(s.max).toBe(50);
  });

  it('computes jitter as mean consecutive deviation', () => {
    const s = new HostStats();
    for (const v of [10_000, 20_000, 15_000]) s.add(result(v));
    // |20-10| = 10, |15-20| = 5 -> mean 7.5
    expect(s.jitter).toBe(7.5);
  });

  it('needs two samples before reporting jitter', () => {
    const s = new HostStats();
    s.add(result(10_000));
    expect(s.jitter).toBeNull();
  });

  it('bounds the rolling window', () => {
    const s = new HostStats(3);
    for (const v of [100_000, 100_000, 100_000, 1_000, 1_000, 1_000]) s.add(result(v));
    // Only the last three (1ms each) remain in the window.
    expect(s.avg).toBe(1);
    // min/max are lifetime, not windowed.
    expect(s.max).toBe(100);
  });
});

describe('formatMs', () => {
  it('renders an em dash for missing values', () => {
    expect(formatMs(null)).toBe('—');
  });

  it('scales precision to magnitude', () => {
    expect(formatMs(1.234)).toBe('1.23 ms');
    expect(formatMs(42.67)).toBe('42.7 ms');
    expect(formatMs(203.4)).toBe('203 ms');
  });
});
