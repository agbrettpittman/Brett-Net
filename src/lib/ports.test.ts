import { describe, expect, it } from 'vitest';
import { estimateScanSeconds, MAX_PORTS, parsePorts } from './ports';

function ok(input: string): number[] {
  const r = parsePorts(input);
  expect(r.error).toBeNull();
  return r.ports;
}

function err(input: string): string {
  const r = parsePorts(input);
  expect(r.error).not.toBeNull();
  expect(r.ports).toEqual([]);
  return r.error!;
}

describe('parsePorts', () => {
  it('parses a single port', () => {
    expect(ok('443')).toEqual([443]);
  });

  it('parses a comma-separated list', () => {
    expect(ok('80, 443,8080')).toEqual([80, 443, 8080]);
  });

  it('parses a range', () => {
    expect(ok('8000-8003')).toEqual([8000, 8001, 8002, 8003]);
  });

  it('mixes ranges and singles without duplicating', () => {
    expect(ok('80, 443, 442-444')).toEqual([80, 443, 442, 444]);
  });

  it('accepts spaces and newlines as separators', () => {
    expect(ok('80 443\n8080')).toEqual([80, 443, 8080]);
  });

  it('ignores surrounding whitespace', () => {
    expect(ok('  443  ')).toEqual([443]);
  });

  it('rejects an empty input', () => {
    expect(err('')).toMatch(/at least one/);
    expect(err('   ')).toMatch(/at least one/);
  });

  it('rejects things that are not numbers', () => {
    expect(err('http')).toMatch(/not a port/);
    expect(err('8o')).toMatch(/not a port/);
    // Number() would happily accept these; the digit check is why it does not.
    expect(err('0x50')).toMatch(/not a port/);
    expect(err('44.3')).toMatch(/not a port/);
  });

  it('rejects ports outside the valid range', () => {
    expect(err('70000')).toMatch(/not a port/);
    // Port 0 means "any" and cannot be connected to.
    expect(err('0')).toMatch(/not a port/);
    expect(err('0-2')).toMatch(/not a port/);
  });

  it('rejects a negative, rather than reading it as a range', () => {
    expect(err('-1')).toBeTruthy();
  });

  it('rejects a backwards range', () => {
    expect(err('443-80')).toMatch(/backwards/);
  });

  it('rejects a malformed range', () => {
    expect(err('1-2-3')).toMatch(/not a port or range/);
  });

  it('accepts the whole port space', () => {
    expect(ok('1-65535')).toHaveLength(MAX_PORTS);
  });

  it('parses a full-range scan fast enough to run while typing', () => {
    // The dedup was a linear scan per port, which at this size is billions of
    // comparisons — enough to lock the window mid-keystroke.
    const started = performance.now();
    ok('1-65535');
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('estimateScanSeconds', () => {
  it('scales with how many batches of workers it takes', () => {
    // One batch of 256 at a 2s timeout.
    expect(estimateScanSeconds(256, 2000)).toBe(2);
    expect(estimateScanSeconds(512, 2000)).toBe(4);
  });

  it('rounds a partial batch up, since it still costs a full timeout', () => {
    expect(estimateScanSeconds(1, 2000)).toBe(2);
    expect(estimateScanSeconds(257, 2000)).toBe(4);
  });

  it('shows a full-range scan as minutes rather than seconds', () => {
    expect(estimateScanSeconds(65535, 2000)).toBeGreaterThan(300);
  });
});
