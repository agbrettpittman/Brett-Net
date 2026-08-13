import type { Adapter } from './ipc';

/**
 * Link speed in the units a network person would say out loud.
 *
 * Drivers report bits per second, and `1000000000` is not a number anyone
 * reads as "gigabit".
 */
export function formatSpeed(bps: number | null): string {
  if (bps === null || bps <= 0) return '—';
  if (bps >= 1e9) {
    const gbps = bps / 1e9;
    return `${Number.isInteger(gbps) ? gbps : gbps.toFixed(1)} Gbps`;
  }
  if (bps >= 1e6) return `${Math.round(bps / 1e6)} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} Kbps`;
  return `${bps} bps`;
}

/**
 * Most interesting first: has a gateway, then active, then by name.
 *
 * A typical Windows machine has a dozen tunnel and virtual adapters, and the
 * one carrying traffic must not be buried among them. **Gateway before
 * active** is the part that matters — loopback and a WSL bridge are both
 * genuinely up and configured, so sorting on "active" alone still pushes the
 * real network adapter below them. Having a default gateway is what actually
 * distinguishes "this is how the machine reaches the world".
 */
export function sortAdapters(adapters: Adapter[]): Adapter[] {
  const rank = (a: Adapter) => (a.gateways.length > 0 ? 0 : a.active ? 1 : 2);

  return [...adapters].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    return byRank !== 0 ? byRank : a.name.localeCompare(b.name);
  });
}

/** IPv4 addresses read first; IPv6 is rarely what someone is looking for. */
export function sortAddresses(addresses: string[]): string[] {
  return [...addresses].sort((a, b) => {
    const av6 = a.includes(':');
    const bv6 = b.includes(':');
    if (av6 !== bv6) return av6 ? 1 : -1;
    return a.localeCompare(b);
  });
}
