import { describe, expect, it } from 'vitest';
import { readBoolean, readNumber, write } from './prefs';

function fake(entries: Record<string, string> = {}) {
  return {
    getItem: (k: string) => entries[k] ?? null,
    setItem: (k: string, v: string) => {
      entries[k] = v;
    },
    entries,
  };
}

const throwing = {
  getItem: () => {
    throw new Error('storage disabled');
  },
  setItem: () => {
    throw new Error('storage disabled');
  },
};

describe('readNumber', () => {
  it('reads a stored number', () => {
    expect(readNumber(fake({ limit: '10' }), 'limit', 5)).toBe(10);
  });

  it('falls back when missing or unparseable', () => {
    expect(readNumber(fake(), 'limit', 5)).toBe(5);
    expect(readNumber(fake({ limit: 'nonsense' }), 'limit', 5)).toBe(5);
  });

  it('keeps a stored zero rather than treating it as absent', () => {
    // Zero is meaningful here — it is how the silent-hop cutoff is disabled.
    expect(readNumber(fake({ limit: '0' }), 'limit', 5)).toBe(0);
  });

  it('falls back when storage throws', () => {
    expect(readNumber(throwing, 'limit', 5)).toBe(5);
  });
});

describe('readBoolean', () => {
  it('round-trips both values', () => {
    const s = fake();
    write(s, 'asn', true);
    expect(readBoolean(s, 'asn', false)).toBe(true);
    write(s, 'asn', false);
    expect(readBoolean(s, 'asn', true)).toBe(false);
  });

  it('falls back when missing or when storage throws', () => {
    expect(readBoolean(fake(), 'asn', true)).toBe(true);
    expect(readBoolean(throwing, 'asn', true)).toBe(true);
  });
});

describe('write', () => {
  it('stores values as strings', () => {
    const s = fake();
    write(s, 'limit', 30);
    expect(s.entries.limit).toBe('30');
  });

  it('does not throw when storage is unavailable', () => {
    expect(() => write(throwing, 'limit', 1)).not.toThrow();
  });
});
