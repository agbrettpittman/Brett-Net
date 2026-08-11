export interface ParsedHost {
  label: string;
  target: string;
}

export interface ParseResult {
  hosts: ParsedHost[];
  errors: string[];
}

/** Expanding anything larger than this at once is almost never intended. */
const MAX_CIDR_HOSTS = 256;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/;
// Deliberately permissive: internal names are often single-label ("router").
const HOSTNAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

function toInt(ip: string): number | null {
  const m = IPV4.exec(ip);
  if (!m) return null;
  const parts = [m[1]!, m[2]!, m[3]!, m[4]!].map(Number);
  if (parts.some((p) => p > 255)) return null;
  // >>> 0 keeps the result unsigned; a leading octet >127 would otherwise go negative.
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function toIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function expandCidr(base: string, bits: number): ParsedHost[] | string {
  if (bits < 0 || bits > 32) return `Invalid prefix /${bits}`;
  const addr = toInt(base);
  if (addr === null) return `Invalid address ${base}`;

  const size = 2 ** (32 - bits);
  if (size > MAX_CIDR_HOSTS) {
    return `${base}/${bits} covers ${size} addresses; /24 or smaller is the limit`;
  }

  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (addr & mask) >>> 0;

  // For /31 and /32 every address is usable; otherwise skip network and broadcast.
  const [first, last] = size <= 2 ? [network, network + size - 1] : [network + 1, network + size - 2];

  const hosts: ParsedHost[] = [];
  for (let n = first; n <= last; n++) {
    const ip = toIp(n >>> 0);
    hosts.push({ label: ip, target: ip });
  }
  return hosts;
}

/**
 * Parses a pasted blob of hosts.
 *
 * Accepts newline, comma, semicolon, or whitespace separation, IPv4 literals,
 * hostnames, and CIDR ranges. An optional `label=target` form names a host.
 */
export function parseHostInput(input: string): ParseResult {
  const hosts: ParsedHost[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const tokens = input
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  for (const token of tokens) {
    let label: string | undefined;
    let value = token;

    const eq = token.indexOf('=');
    if (eq > 0) {
      label = token.slice(0, eq).trim();
      value = token.slice(eq + 1).trim();
    }

    const cidr = CIDR.exec(value);
    if (cidr) {
      const expanded = expandCidr(cidr[1]!, Number(cidr[2]));
      if (typeof expanded === 'string') {
        errors.push(expanded);
      } else {
        for (const h of expanded) {
          if (!seen.has(h.target)) {
            seen.add(h.target);
            hosts.push(h);
          }
        }
      }
      continue;
    }

    const isIp = toInt(value) !== null;
    // Digits-and-dots is always an attempt at an IP address. Treating a typo
    // like "999.1.1.1" as a hostname would technically parse, then fail later
    // at resolution with a far less useful message.
    if (!isIp && /^[\d.]+$/.test(value)) {
      errors.push(`Not a valid IP address: ${value}`);
      continue;
    }
    if (!isIp && !HOSTNAME.test(value)) {
      errors.push(`Not a valid host: ${value}`);
      continue;
    }

    if (!seen.has(value)) {
      seen.add(value);
      hosts.push({ label: label || value, target: value });
    }
  }

  return { hosts, errors };
}
