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

export interface ConnectionGroup {
  /** Stable across refreshes, and the React key. */
  key: string;
  /** The socket that represents the group in the table. */
  lead: Connection;
  /** Every socket in the group, `lead` included. Length 1 unless pooled. */
  members: Connection[];
}

/**
 * Folds established sockets sharing a process and a remote endpoint into one
 * group — a pool of six connections to one server is one conversation, not six
 * rows. Everything else (listeners, closing sockets) stays one per group, so
 * the only visible change is pools collapsing.
 *
 * Input order is kept: a group sits where its first member was, so a sorted
 * list stays sorted.
 */
export function groupConnections(connections: Connection[]): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>();

  for (const c of connections) {
    // A listener or a Time-wait remnant is individually meaningful; only a live,
    // attributable pool collapses.
    const poolable = c.state === 'Established' && c.process !== null;
    const key = poolable ? `pool:${c.process}:${c.remoteAddr}:${c.remotePort}` : `one:${c.id}`;

    const existing = groups.get(key);
    if (existing) existing.members.push(c);
    else groups.set(key, { key, lead: c, members: [c] });
  }

  return [...groups.values()];
}

/** Mirrors `conn::watch::WatchSpec`. */
export interface WatchSpec {
  id: string;
  /** Null matches any peer, which is what a whole-process watch needs. */
  remoteAddr: string | null;
  remotePort: number | null;
  /** Matched by executable name, so an app restarting isn't a death. */
  process: string | null;
  /** The exact five-tuple, when only one socket counts. */
  socket: string | null;
  label: string;
}

/** How wide a watch is. Each is narrower than the one before. */
export type WatchKind = 'process' | 'peer' | 'socket';

export const WATCH_KIND_LABEL: Record<WatchKind, string> = {
  process: 'Process',
  peer: 'Peer',
  socket: 'Socket',
};

/** Reads the width back off a spec, for display. */
export function watchKind(spec: WatchSpec): WatchKind {
  if (spec.socket !== null) return 'socket';
  return spec.remoteAddr === null ? 'process' : 'peer';
}

/** Mirrors `conn::watch::Verdict`. */
export type Verdict =
  | 'processExited'
  | 'localClosed'
  | 'remoteClosed'
  | 'neverConnected'
  | 'abrupt';

export interface WatchEvent {
  watchId: string;
  label: string;
  at: number;
  up: boolean;
  verdict: Verdict | null;
  detail: string;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  processExited: 'Process exited',
  localClosed: 'Closed locally',
  remoteClosed: 'Closed by far end',
  neverConnected: 'Never connected',
  abrupt: 'Dropped',
};

/** Only an abrupt drop is a network question; the rest are normal endings. */
export function isFault(verdict: Verdict | null): boolean {
  return verdict === 'abrupt';
}

/**
 * Builds a watch for a connection at one of the three widths.
 *
 * `peer` — is this application still talking to this host — is the right
 * default for anything pooling connections, where individual sockets are
 * replaced constantly. `process` widens that to any peer at all, which is what
 * you want for something like a sync client that talks to a rotating set of
 * front-end addresses. `socket` pins one exact five-tuple.
 *
 * A `process` watch on an unnamed row is refused rather than silently matching
 * everything: without a name there is nothing to narrow by.
 */
export function watchFor(c: Connection, kind: WatchKind): WatchSpec | null {
  const peer = endpoint(c.remoteAddr, c.remotePort, c.v6);
  const who = c.process ?? `pid ${c.pid}`;

  if (kind === 'socket') {
    return {
      id: `s:${c.id}`,
      remoteAddr: c.remoteAddr,
      remotePort: c.remotePort,
      process: c.process,
      socket: c.id,
      label: `${who} ${endpoint(c.localAddr, c.localPort, c.v6)} → ${peer}`,
    };
  }

  if (kind === 'process') {
    if (c.process === null) return null;
    return {
      id: `p:${c.process}`,
      remoteAddr: null,
      remotePort: null,
      process: c.process,
      socket: null,
      label: `${c.process} — any peer`,
    };
  }

  return {
    id: `e:${c.process ?? ''}:${c.remoteAddr}:${c.remotePort}`,
    remoteAddr: c.remoteAddr,
    remotePort: c.remotePort,
    process: c.process,
    socket: null,
    label: `${who} → ${peer}`,
  };
}

/** Whether this exact watch is already registered. */
export function isWatched(watches: WatchSpec[], c: Connection, kind: WatchKind): boolean {
  const spec = watchFor(c, kind);
  return spec !== null && watches.some((w) => w.id === spec.id);
}

/** How many rows each state accounts for, for the summary line. */
export function countByState(connections: Connection[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of connections) out.set(c.state, (out.get(c.state) ?? 0) + 1);
  return out;
}
