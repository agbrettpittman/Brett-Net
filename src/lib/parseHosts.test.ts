import { describe, expect, it } from 'vitest';
import { parseHostInput } from './parseHosts';

const targets = (s: string) => parseHostInput(s).hosts.map((h) => h.target);

describe('parseHostInput', () => {
  it('handles an empty string', () => {
    expect(parseHostInput('')).toEqual({ hosts: [], errors: [] });
  });

  it('splits on newlines, commas, semicolons, and whitespace', () => {
    expect(targets('8.8.8.8\n1.1.1.1, 9.9.9.9; 8.8.4.4  4.4.4.4')).toEqual([
      '8.8.8.8',
      '1.1.1.1',
      '9.9.9.9',
      '8.8.4.4',
      '4.4.4.4',
    ]);
  });

  it('accepts hostnames, including single-label internal names', () => {
    expect(targets('google.com router firewall.corp.local')).toEqual([
      'google.com',
      'router',
      'firewall.corp.local',
    ]);
  });

  it('deduplicates', () => {
    expect(targets('8.8.8.8 8.8.8.8 8.8.8.8')).toEqual(['8.8.8.8']);
  });

  it('supports label=target', () => {
    const { hosts } = parseHostInput('Gateway=192.168.1.1');
    expect(hosts).toEqual([{ label: 'Gateway', target: '192.168.1.1' }]);
  });

  it('defaults the label to the target', () => {
    expect(parseHostInput('8.8.8.8').hosts[0]).toEqual({
      label: '8.8.8.8',
      target: '8.8.8.8',
    });
  });

  it('rejects octets above 255', () => {
    const { hosts, errors } = parseHostInput('999.1.1.1');
    // Not a valid IP, and the dotted form is not a valid hostname either.
    expect(hosts).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('expands a /30 to its two usable addresses', () => {
    expect(targets('192.168.1.0/30')).toEqual(['192.168.1.1', '192.168.1.2']);
  });

  it('expands a /24 without network or broadcast', () => {
    const t = targets('10.0.0.0/24');
    expect(t).toHaveLength(254);
    expect(t[0]).toBe('10.0.0.1');
    expect(t.at(-1)).toBe('10.0.0.254');
    expect(t).not.toContain('10.0.0.0');
    expect(t).not.toContain('10.0.0.255');
  });

  it('treats /32 as a single usable address', () => {
    expect(targets('10.0.0.7/32')).toEqual(['10.0.0.7']);
  });

  it('normalises a CIDR given with a host bit set', () => {
    // 10.0.0.5/24 means the 10.0.0.0/24 network.
    const t = targets('10.0.0.5/24');
    expect(t[0]).toBe('10.0.0.1');
    expect(t).toHaveLength(254);
  });

  it('refuses ranges larger than a /24', () => {
    const { hosts, errors } = parseHostInput('10.0.0.0/16');
    expect(hosts).toEqual([]);
    expect(errors[0]).toContain('65536');
  });

  it('handles high first octets without sign overflow', () => {
    // 200 >> would go negative without an unsigned shift.
    expect(targets('200.0.0.0/30')).toEqual(['200.0.0.1', '200.0.0.2']);
  });

  it('collects errors while still returning the valid hosts', () => {
    const { hosts, errors } = parseHostInput('8.8.8.8\n!!bad!!\n1.1.1.1');
    expect(hosts.map((h) => h.target)).toEqual(['8.8.8.8', '1.1.1.1']);
    expect(errors).toHaveLength(1);
  });
});
