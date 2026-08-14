/** Mirrors `conn::Connection`. */
export interface Connection {
  /** The five-tuple. Unique by definition, so it doubles as the row key. */
  id: string;
  localAddr: string;
  localPort: number;
  remoteAddr: string;
  remotePort: number;
  state: string;
  pid: number;
  /** Null when the owning process could not be named — normally another user's. */
  process: string | null;
  v6: boolean;
}

export interface ConnectionFilter {
  /** Free text over process, address and port. */
  search: string;
  /** Hide anything that is not an established conversation. */
  establishedOnly: boolean;
  /** Hide traffic that never leaves the machine. */
  hideLoopback: boolean;
}

export const DEFAULT_FILTER: ConnectionFilter = {
  search: '',
  establishedOnly: true,
  hideLoopback: true,
};

/** `host:port`, with IPv6 bracketed so the port is still readable. */
export function endpoint(addr: string, port: number, v6: boolean): string {
  return v6 ? `[${addr}]:${port}` : `${addr}:${port}`;
}

/** A listener has no peer yet, so its remote is all-zeroes rather than absent. */
export function isListener(c: Connection): boolean {
  return c.state === 'Listen';
}

export function isLoopback(c: Connection): boolean {
  return (
    c.remoteAddr.startsWith('127.') ||
    c.localAddr.startsWith('127.') ||
    c.remoteAddr === '::1' ||
    c.localAddr === '::1'
  );
}

/** Everything one row could be searched by, lower-cased once. */
function haystack(c: Connection): string {
  return [
    c.process ?? '',
    String(c.pid),
    c.localAddr,
    String(c.localPort),
    c.remoteAddr,
    String(c.remotePort),
    c.state,
  ]
    .join(' ')
    .toLowerCase();
}

export function filterConnections(
  connections: Connection[],
  filter: ConnectionFilter,
): Connection[] {
  // Split on whitespace so "chrome 443" narrows by both rather than looking for
  // that exact string, which never matches anything.
  const terms = filter.search.toLowerCase().split(/\s+/).filter(Boolean);

  return connections.filter((c) => {
    if (filter.establishedOnly && c.state !== 'Established') return false;
    if (filter.hideLoopback && isLoopback(c)) return false;
    if (terms.length === 0) return true;

    const text = haystack(c);
    return terms.every((t) => text.includes(t));
  });
}

/**
 * Established first, then by process, then by peer.
 *
 * Established connections are the ones worth watching; listeners and the debris
 * of closing sockets are context. Grouping by process after that keeps one
 * application's conversations together, which is how anyone reads this table.
 */
export function sortConnections(connections: Connection[]): Connection[] {
  const rank = (c: Connection) => (c.state === 'Established' ? 0 : isListener(c) ? 1 : 2);

  return [...connections].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;

    // Unnamed processes sort last rather than first, where an empty string
    // would otherwise put them.
    const an = a.process ?? '￿';
    const bn = b.process ?? '￿';
    const byName = an.localeCompare(bn);
    if (byName !== 0) return byName;

    return a.remoteAddr.localeCompare(b.remoteAddr) || a.remotePort - b.remotePort;
  });
}

/** How many rows each state accounts for, for the summary line. */
export function countByState(connections: Connection[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of connections) out.set(c.state, (out.get(c.state) ?? 0) + 1);
  return out;
}
