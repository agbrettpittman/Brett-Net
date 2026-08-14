import { ICMP, type HostSpec, type ProbeMode } from './ipc';

/** Just enough of a host to say how it is probed. */
type Probed = Pick<HostSpec, 'probe'>;

/** The probe a host actually uses. An absent mode means ICMP. */
export function probeOf(host: Probed): ProbeMode {
  return host.probe ?? ICMP;
}

/** Short badge text for the host table, or null for the ICMP default. */
export function probeBadge(host: Probed): string | null {
  const p = probeOf(host);
  return p.mode === 'tcp' ? `TCP ${p.port}` : null;
}

/**
 * Identity for de-duplication.
 *
 * The port is part of it on purpose: the same address checked on two different
 * ports is two different checks, and keying on the target alone would silently
 * swallow the second one.
 */
export function hostKey(host: Probed & Pick<HostSpec, 'target'>): string {
  const p = probeOf(host);
  return `${host.target.toLowerCase()}|${p.mode === 'tcp' ? p.port : 'icmp'}`;
}

/**
 * Validates a typed port.
 *
 * Port 0 is rejected rather than clamped: it parses, but it means "any port" and
 * cannot be connected to, so accepting it would produce a host that silently
 * never succeeds.
 */
export function parsePort(text: string): { port: number } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { error: 'Port is required' };
  if (!/^\d+$/.test(trimmed)) return { error: 'Port must be a number' };

  const port = Number(trimmed);
  if (port < 1 || port > 65535) return { error: 'Port must be 1–65535' };
  return { port };
}
