import { describe, expect, it } from 'vitest';
import { parsePort, probeBadge, probeOf } from './probeMode';
import type { HostSpec } from './ipc';

const host = (probe?: HostSpec['probe']): HostSpec => ({
  id: 'h',
  label: 'H',
  target: '10.0.0.1',
  probe,
});

describe('probeOf', () => {
  it('treats a host with no mode as ICMP', () => {
    // Every host saved before TCP mode existed looks like this.
    expect(probeOf(host())).toEqual({ mode: 'icmp' });
  });

  it('keeps an explicit TCP mode', () => {
    expect(probeOf(host({ mode: 'tcp', port: 443 }))).toEqual({ mode: 'tcp', port: 443 });
  });
});

describe('probeBadge', () => {
  it('says nothing for the default', () => {
    expect(probeBadge(host())).toBeNull();
    expect(probeBadge(host({ mode: 'icmp' }))).toBeNull();
  });

  it('names the port for a TCP host', () => {
    expect(probeBadge(host({ mode: 'tcp', port: 22 }))).toBe('TCP 22');
  });
});

describe('parsePort', () => {
  it('accepts a port in range', () => {
    expect(parsePort('443')).toEqual({ port: 443 });
    expect(parsePort('  8080 ')).toEqual({ port: 8080 });
    expect(parsePort('65535')).toEqual({ port: 65535 });
  });

  it('rejects port 0, which parses but cannot be connected to', () => {
    expect(parsePort('0')).toHaveProperty('error');
  });

  it('rejects anything out of range or not a number', () => {
    for (const bad of ['', '65536', '-1', '80.5', '443x', 'http']) {
      expect(parsePort(bad), bad).toHaveProperty('error');
    }
  });
});
