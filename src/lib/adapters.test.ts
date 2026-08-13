import { describe, expect, it } from 'vitest';
import { formatSpeed, sortAdapters, sortAddresses } from './adapters';
import type { Adapter } from './ipc';

function adapter(name: string, active: boolean, gateways: string[] = []): Adapter {
  return {
    name,
    description: name,
    kind: 'Ethernet',
    status: active ? 'Up' : 'Down',
    mac: null,
    mtu: 1500,
    speedBps: null,
    addresses: active ? ['192.168.1.5/24'] : [],
    gateways,
    dns: [],
    dhcpServer: null,
    active,
  };
}

describe('formatSpeed', () => {
  it('reads gigabit as gigabit', () => {
    expect(formatSpeed(1e9)).toBe('1 Gbps');
    expect(formatSpeed(2.5e9)).toBe('2.5 Gbps');
  });

  it('reads megabit as megabit', () => {
    expect(formatSpeed(1e8)).toBe('100 Mbps');
    expect(formatSpeed(54e6)).toBe('54 Mbps');
  });

  it('handles slower links', () => {
    expect(formatSpeed(64000)).toBe('64 Kbps');
    expect(formatSpeed(300)).toBe('300 bps');
  });

  it('is a dash when the driver does not report a speed', () => {
    expect(formatSpeed(null)).toBe('—');
    expect(formatSpeed(0)).toBe('—');
  });
});

describe('sortAdapters', () => {
  it('puts the adapter with a gateway first, even below-alphabet', () => {
    // The real case this exists for: loopback and a WSL bridge are both up and
    // configured, and would otherwise sort above the Wi-Fi actually in use.
    const sorted = sortAdapters([
      adapter('Loopback Pseudo-Interface 1', true),
      adapter('vEthernet (WSL)', true),
      adapter('Wi-Fi', true, ['192.168.1.1']),
    ]);
    expect(sorted[0]!.name).toBe('Wi-Fi');
  });

  it('puts active adapters above inactive ones', () => {
    const sorted = sortAdapters([
      adapter('Bluetooth', false),
      adapter('Wi-Fi', true),
      adapter('Aardvark tunnel', false),
    ]);
    expect(sorted.map((a) => a.name)).toEqual(['Wi-Fi', 'Aardvark tunnel', 'Bluetooth']);
  });

  it('sorts within each group by name', () => {
    const sorted = sortAdapters([adapter('Wi-Fi', true), adapter('Ethernet', true)]);
    expect(sorted.map((a) => a.name)).toEqual(['Ethernet', 'Wi-Fi']);
  });

  it('does not mutate the input', () => {
    const input = [adapter('B', false), adapter('A', true)];
    sortAdapters(input);
    expect(input.map((a) => a.name)).toEqual(['B', 'A']);
  });
});

describe('sortAddresses', () => {
  it('puts IPv4 before IPv6', () => {
    expect(sortAddresses(['fe80::1/64', '192.168.1.5/24'])).toEqual([
      '192.168.1.5/24',
      'fe80::1/64',
    ]);
  });

  it('leaves a single family in name order', () => {
    expect(sortAddresses(['192.168.1.9/24', '192.168.1.5/24'])).toEqual([
      '192.168.1.5/24',
      '192.168.1.9/24',
    ]);
  });
});
