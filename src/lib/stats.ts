import type { PingResult } from './ipc';

/**
 * Rolling per-host statistics.
 *
 * Counts every probe for loss, but only successful probes contribute latency —
 * a timeout has no RTT, and treating it as zero would drag the average down and
 * make an outage look like an improvement.
 */
export class HostStats {
  private readonly window: number;
  private recent: number[] = [];
  sent = 0;
  lost = 0;
  last: number | null = null;
  min: number | null = null;
  max: number | null = null;

  constructor(window = 100) {
    this.window = window;
  }

  add(result: PingResult): void {
    this.sent += 1;

    if (result.status !== 'success' || result.rttUs === null) {
      this.lost += 1;
      this.last = null;
      return;
    }

    const ms = result.rttUs / 1000;
    this.last = ms;
    this.min = this.min === null ? ms : Math.min(this.min, ms);
    this.max = this.max === null ? ms : Math.max(this.max, ms);

    this.recent.push(ms);
    if (this.recent.length > this.window) this.recent.shift();
  }

  /** Mean latency over the recent window, or null if nothing has succeeded. */
  get avg(): number | null {
    if (this.recent.length === 0) return null;
    let sum = 0;
    for (const v of this.recent) sum += v;
    return sum / this.recent.length;
  }

  /** Mean absolute difference between consecutive samples. */
  get jitter(): number | null {
    if (this.recent.length < 2) return null;
    let sum = 0;
    for (let i = 1; i < this.recent.length; i++) {
      sum += Math.abs(this.recent[i]! - this.recent[i - 1]!);
    }
    return sum / (this.recent.length - 1);
  }

  /** Packet loss as a percentage of all probes sent. */
  get lossPct(): number {
    return this.sent === 0 ? 0 : (this.lost / this.sent) * 100;
  }
}

export function formatMs(v: number | null): string {
  if (v === null) return '—';
  if (v < 10) return `${v.toFixed(2)} ms`;
  if (v < 100) return `${v.toFixed(1)} ms`;
  return `${Math.round(v)} ms`;
}
