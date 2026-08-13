import type { AsnInfo, PingStatus, TraceHop, TraceOutcome } from './ipc';

/**
 * Fastest probe to a hop, in milliseconds, or null if none answered.
 *
 * Traceroute reports the best rather than the mean because an intermediate
 * router answering an ICMP echo is doing so at its own convenience — a slow
 * reply says the router was busy, not that the path is slow. The fastest is the
 * closest thing to the real transit time.
 */
export function hopBest(rttsUs: (number | null)[]): number | null {
  let best: number | null = null;
  for (const v of rttsUs) {
    if (v === null) continue;
    if (best === null || v < best) best = v;
  }
  return best === null ? null : best / 1000;
}

/** Fraction of probes to this hop that went unanswered, 0–1. */
export function hopLoss(rttsUs: (number | null)[]): number {
  if (rttsUs.length === 0) return 0;
  return rttsUs.filter((v) => v === null).length / rttsUs.length;
}

/**
 * Short note for a hop whose reply means something beyond "it answered".
 *
 * `ttlExpired` is what every intermediate router is *supposed* to send, so it
 * gets no note — flagging it would mark the entire path as abnormal.
 */
export function hopNote(status: PingStatus): string | null {
  switch (status) {
    case 'destHostUnreachable':
      return 'host unreachable';
    case 'destNetUnreachable':
      return 'network unreachable';
    case 'dnsFailure':
      return 'DNS failed';
    case 'other':
      return 'error';
    default:
      return null;
  }
}

/** Plain-language summary of why a trace stopped. */
export function outcomeMessage(outcome: TraceOutcome, hops: TraceHop[]): string {
  const n = hops.length;
  switch (outcome) {
    case 'reached':
      return `Reached in ${n} hop${n === 1 ? '' : 's'}.`;
    case 'maxHops':
      return `Stopped after ${n} hops without reaching the target.`;
    case 'filtered':
      // The single most common result on a corporate network, and the one most
      // likely to be mistaken for a broken app. It also names the setting, so
      // it is obvious the cutoff is a choice rather than a limitation.
      return 'Stopped early — several hops in a row did not respond. The path is probably filtered rather than broken. Raise "Give up after" to keep going.';
    case 'cancelled':
      return 'Stopped.';
  }
}

/** True once the trace has anything worth showing a table for. */
export function hasResults(hops: TraceHop[]): boolean {
  return hops.length > 0;
}

/**
 * How an AS number is conventionally written.
 *
 * The `AS` prefix matters: a bare number in a column of milliseconds is
 * ambiguous, and `AS13335` is what you would paste into a lookup.
 */
export function formatAsn(asn: number | null): string {
  return asn === null ? '' : `AS${asn}`;
}

/**
 * Operator name with a redundant AS-number prefix removed.
 *
 * Some networks have no registered handle, so the name comes back as
 * `AS6453 - TATA COMMUNICATIONS (AMERICA) INC` — printed next to its own ASN
 * column that reads `AS6453`, which just wastes the width.
 */
export function networkName(info: AsnInfo): string {
  const name = info.name ?? '';
  if (info.asn === null) return name;

  const prefix = `AS${info.asn} - `;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
