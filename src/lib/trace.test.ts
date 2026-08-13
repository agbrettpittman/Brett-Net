import { describe, expect, it } from 'vitest';
import { formatAsn, hopBest, hopLoss, hopNote, networkName, outcomeMessage } from './trace';
import type { AsnInfo, TraceHop } from './ipc';

function hop(ttl: number): TraceHop {
  return { ttl, addr: '10.0.0.1', rttsUs: [1000], status: 'ttlExpired', reached: false };
}

describe('hopBest', () => {
  it('takes the fastest probe, not the mean', () => {
    // A slow reply means a busy router, not a slow path.
    expect(hopBest([9000, 2000, 5000])).toBe(2);
  });

  it('ignores probes that timed out', () => {
    expect(hopBest([null, 3000, null])).toBe(3);
  });

  it('is null when nothing answered', () => {
    expect(hopBest([null, null, null])).toBeNull();
    expect(hopBest([])).toBeNull();
  });
});

describe('hopLoss', () => {
  it('is the share of unanswered probes', () => {
    expect(hopLoss([1000, null, 1000])).toBeCloseTo(1 / 3);
    expect(hopLoss([1000, 1000])).toBe(0);
    expect(hopLoss([null, null])).toBe(1);
  });

  it('is zero for no probes rather than dividing by zero', () => {
    expect(hopLoss([])).toBe(0);
  });
});

describe('hopNote', () => {
  it('says nothing for the statuses a healthy trace produces', () => {
    // Every intermediate router is meant to answer ttlExpired, and the target
    // answers success — neither is worth flagging.
    expect(hopNote('ttlExpired')).toBeNull();
    expect(hopNote('success')).toBeNull();
    expect(hopNote('timedOut')).toBeNull();
  });

  it('flags replies that carry real information', () => {
    expect(hopNote('destHostUnreachable')).toBe('host unreachable');
    expect(hopNote('destNetUnreachable')).toBe('network unreachable');
  });
});

describe('outcomeMessage', () => {
  it('counts the hops it took to arrive', () => {
    expect(outcomeMessage('reached', [hop(1), hop(2)])).toBe('Reached in 2 hops.');
    expect(outcomeMessage('reached', [hop(1)])).toBe('Reached in 1 hop.');
  });

  it('explains a filtered path rather than implying a failure', () => {
    const msg = outcomeMessage('filtered', [hop(1)]);
    expect(msg).toMatch(/filtered/);
    expect(msg).not.toMatch(/error|failed/i);
  });

  it('points at the setting that changes the cutoff', () => {
    expect(outcomeMessage('filtered', [hop(1)])).toMatch(/Give up after/);
  });

  it('covers every outcome', () => {
    const outcomes = ['reached', 'maxHops', 'filtered', 'cancelled'] as const;
    for (const o of outcomes) {
      expect(outcomeMessage(o, [hop(1)])).toBeTruthy();
    }
  });
});

describe('formatAsn', () => {
  it('writes an AS number the conventional way', () => {
    expect(formatAsn(13335)).toBe('AS13335');
  });

  it('is blank for an address with no ASN', () => {
    expect(formatAsn(null)).toBe('');
  });
});

describe('networkName', () => {
  function info(asn: number | null, name: string | null): AsnInfo {
    return { ip: '1.1.1.1', asn, name, prefix: null, country: null };
  }

  it('drops a prefix that only repeats the ASN column', () => {
    // Networks with no registered handle come back like this.
    expect(networkName(info(6453, 'AS6453 - TATA COMMUNICATIONS (AMERICA) INC'))).toBe(
      'TATA COMMUNICATIONS (AMERICA) INC',
    );
  });

  it('leaves a real handle alone', () => {
    expect(networkName(info(174, 'COGENT-174 - Cogent Communications, LLC'))).toBe(
      'COGENT-174 - Cogent Communications, LLC',
    );
  });

  it('does not strip a different ASN that happens to appear', () => {
    expect(networkName(info(174, 'AS6453 - SOMEONE ELSE'))).toBe('AS6453 - SOMEONE ELSE');
  });

  it('handles a missing name', () => {
    expect(networkName(info(174, null))).toBe('');
  });
});
