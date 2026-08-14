import { describe, expect, it } from 'vitest';
import {
  countByState,
  DEFAULT_FILTER,
  endpoint,
  filterConnections,
  isListener,
  isLoopback,
  isFault,
  isWatched,
  sortConnections,
  VERDICT_LABEL,
  watchFor,
  watchKind,
  WATCH_KIND_LABEL,
  type Connection,
} from './connections';

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: over.id ?? Math.random().toString(36),
  localAddr: '192.168.1.5',
  localPort: 54321,
  remoteAddr: '142.250.72.14',
  remotePort: 443,
  state: 'Established',
  pid: 1234,
  process: 'chrome.exe',
  v6: false,
  ...over,
});

describe('endpoint', () => {
  it('brackets IPv6 so the port stays readable', () => {
    expect(endpoint('2606:4700::1111', 443, true)).toBe('[2606:4700::1111]:443');
    expect(endpoint('1.1.1.1', 443, false)).toBe('1.1.1.1:443');
  });
});

describe('isLoopback', () => {
  it('catches either end, v4 or v6', () => {
    expect(isLoopback(conn({ remoteAddr: '127.0.0.1' }))).toBe(true);
    expect(isLoopback(conn({ localAddr: '127.0.0.53' }))).toBe(true);
    expect(isLoopback(conn({ remoteAddr: '::1' }))).toBe(true);
    expect(isLoopback(conn())).toBe(false);
  });

  it('does not mistake a public address that merely starts with 12', () => {
    expect(isLoopback(conn({ remoteAddr: '12.7.0.1' }))).toBe(false);
  });
});

describe('filterConnections', () => {
  it('keeps only established by default', () => {
    const rows = [conn(), conn({ state: 'Listen' }), conn({ state: 'Time wait' })];
    expect(filterConnections(rows, DEFAULT_FILTER)).toHaveLength(1);
  });

  it('hides loopback by default', () => {
    const rows = [conn(), conn({ remoteAddr: '127.0.0.1' })];
    expect(filterConnections(rows, DEFAULT_FILTER)).toHaveLength(1);
  });

  it('shows everything when both toggles are off', () => {
    const rows = [conn({ state: 'Listen' }), conn({ remoteAddr: '127.0.0.1' })];
    const all = filterConnections(rows, {
      search: '',
      establishedOnly: false,
      hideLoopback: false,
    });
    expect(all).toHaveLength(2);
  });

  it('searches process, address, port, pid and state', () => {
    const rows = [
      conn({ process: 'chrome.exe' }),
      conn({ process: 'Teams.exe', remoteAddr: '52.113.194.132' }),
    ];
    const only = (search: string) =>
      filterConnections(rows, { ...DEFAULT_FILTER, search }).length;

    expect(only('chrome')).toBe(1);
    expect(only('52.113')).toBe(1);
    expect(only('1234')).toBe(2);
    expect(only('established')).toBe(2);
  });

  it('is case insensitive', () => {
    expect(
      filterConnections([conn({ process: 'Teams.exe' })], {
        ...DEFAULT_FILTER,
        search: 'TEAMS',
      }),
    ).toHaveLength(1);
  });

  it('treats several words as narrowing, not as one string', () => {
    // "chrome 443" should mean both, not a literal "chrome 443" that matches
    // nothing at all.
    const rows = [
      conn({ process: 'chrome.exe', remotePort: 443 }),
      conn({ process: 'chrome.exe', remotePort: 80 }),
    ];
    expect(filterConnections(rows, { ...DEFAULT_FILTER, search: 'chrome 443' })).toHaveLength(1);
  });

  it('survives a search of only whitespace', () => {
    const rows = [conn()];
    expect(filterConnections(rows, { ...DEFAULT_FILTER, search: '   ' })).toHaveLength(1);
  });

  it('matches rows with no process name by their other fields', () => {
    const rows = [conn({ process: null, remoteAddr: '10.0.0.9' })];
    expect(filterConnections(rows, { ...DEFAULT_FILTER, search: '10.0.0.9' })).toHaveLength(1);
  });
});

describe('sortConnections', () => {
  it('puts established first, then listeners, then the rest', () => {
    const rows = [
      conn({ state: 'Time wait' }),
      conn({ state: 'Listen' }),
      conn({ state: 'Established' }),
    ];
    expect(sortConnections(rows).map((c) => c.state)).toEqual([
      'Established',
      'Listen',
      'Time wait',
    ]);
  });

  it('groups an application’s conversations together', () => {
    const rows = [
      conn({ process: 'zoom.exe' }),
      conn({ process: 'chrome.exe' }),
      conn({ process: 'Teams.exe' }),
    ];
    expect(sortConnections(rows).map((c) => c.process)).toEqual([
      'chrome.exe',
      'Teams.exe',
      'zoom.exe',
    ]);
  });

  it('sorts unnamed processes last rather than first', () => {
    // An empty string would otherwise sort above every real name.
    const rows = [conn({ process: null }), conn({ process: 'chrome.exe' })];
    expect(sortConnections(rows).map((c) => c.process)).toEqual(['chrome.exe', null]);
  });

  it('breaks a tie on the peer', () => {
    const rows = [
      conn({ process: 'a.exe', remoteAddr: '9.9.9.9' }),
      conn({ process: 'a.exe', remoteAddr: '1.1.1.1' }),
    ];
    expect(sortConnections(rows).map((c) => c.remoteAddr)).toEqual(['1.1.1.1', '9.9.9.9']);
  });

  it('does not mutate its input', () => {
    const rows = [conn({ state: 'Listen' }), conn({ state: 'Established' })];
    sortConnections(rows);
    expect(rows[0]!.state).toBe('Listen');
  });
});

describe('countByState', () => {
  it('tallies each state', () => {
    const counts = countByState([conn(), conn(), conn({ state: 'Listen' })]);
    expect(counts.get('Established')).toBe(2);
    expect(counts.get('Listen')).toBe(1);
  });

  it('is empty for no rows', () => {
    expect(countByState([]).size).toBe(0);
  });
});

describe('isListener', () => {
  it('keys off the state, not the address', () => {
    expect(isListener(conn({ state: 'Listen' }))).toBe(true);
    expect(isListener(conn())).toBe(false);
  });
});

describe('watchFor', () => {
  it('builds an endpoint watch that ignores the local port', () => {
    // Two sockets from one app to one peer must produce the same watch, or a
    // pool would be watched several times over.
    const a = watchFor(conn({ localPort: 1000, id: 'a' }), 'peer')!;
    const b = watchFor(conn({ localPort: 2000, id: 'b' }), 'peer')!;
    expect(a.id).toBe(b.id);
    expect(a.socket).toBeNull();
  });

  it('separates the same peer reached by different applications', () => {
    const chrome = watchFor(conn({ process: 'chrome.exe' }), 'peer')!;
    const teams = watchFor(conn({ process: 'Teams.exe' }), 'peer')!;
    expect(chrome.id).not.toBe(teams.id);
  });

  it('separates different ports on the same host', () => {
    const https = watchFor(conn({ remotePort: 443 }), 'peer')!;
    const http = watchFor(conn({ remotePort: 80 }), 'peer')!;
    expect(https.id).not.toBe(http.id);
  });

  it('pins the five-tuple for a socket watch', () => {
    const w = watchFor(conn({ id: 'the-socket' }), 'socket')!;
    expect(w.socket).toBe('the-socket');
    expect(w.id).not.toBe(watchFor(conn({ id: 'other' }), 'socket')!.id);
  });

  it('labels an unnamed process by its pid rather than leaving a gap', () => {
    const w = watchFor(conn({ process: null, pid: 987 }), 'peer')!;
    expect(w.label).toContain('pid 987');
  });

  it('brackets IPv6 in the label', () => {
    const w = watchFor(conn({ remoteAddr: '2606:4700::1111', v6: true }), 'peer')!;
    expect(w.label).toContain('[2606:4700::1111]:443');
  });
});

describe('isWatched', () => {
  it('recognises a registered endpoint watch from any of its sockets', () => {
    const c = conn({ id: 'a' });
    const watches = [watchFor(c, 'peer')!];
    expect(isWatched(watches, conn({ id: 'b' }), 'peer')).toBe(true);
  });

  it('does not confuse the two kinds', () => {
    const c = conn();
    expect(isWatched([watchFor(c, 'peer')!], c, 'socket')).toBe(false);
  });

  it('is false against an empty list', () => {
    expect(isWatched([], conn(), 'peer')).toBe(false);
  });
});

describe('isFault', () => {
  it('treats only an abrupt drop as a network question', () => {
    expect(isFault('abrupt')).toBe(true);
    for (const v of ['processExited', 'localClosed', 'remoteClosed', 'neverConnected'] as const) {
      expect(isFault(v), v).toBe(false);
    }
    expect(isFault(null)).toBe(false);
  });
});

describe('VERDICT_LABEL', () => {
  it('names every verdict', () => {
    for (const v of Object.values(VERDICT_LABEL)) expect(v.length).toBeGreaterThan(0);
  });
});

describe('watchFor process kind', () => {
  it('watches every peer of one application', () => {
    const w = watchFor(conn({ process: 'GoogleDriveFS.exe' }), 'process')!;
    expect(w.remoteAddr).toBeNull();
    expect(w.remotePort).toBeNull();
    expect(w.process).toBe('GoogleDriveFS.exe');
  });

  it('is the same watch whichever of that app’s rows you start from', () => {
    const a = watchFor(conn({ process: 'GoogleDriveFS.exe', remoteAddr: '172.217.113.4' }), 'process')!;
    const b = watchFor(conn({ process: 'GoogleDriveFS.exe', remoteAddr: '172.217.115.4' }), 'process')!;
    expect(a.id).toBe(b.id);
  });

  it('is refused for an unnamed process rather than matching everything', () => {
    // Without a name there is nothing to narrow by, and a spec that narrows by
    // nothing would watch the entire machine.
    expect(watchFor(conn({ process: null }), 'process')).toBeNull();
    expect(isWatched([], conn({ process: null }), 'process')).toBe(false);
  });

  it('does not collide with the peer watch for the same row', () => {
    const c = conn();
    expect(watchFor(c, 'process')!.id).not.toBe(watchFor(c, 'peer')!.id);
  });
});

describe('watchKind', () => {
  it('reads the width back off a spec', () => {
    const c = conn();
    expect(watchKind(watchFor(c, 'process')!)).toBe('process');
    expect(watchKind(watchFor(c, 'peer')!)).toBe('peer');
    expect(watchKind(watchFor(c, 'socket')!)).toBe('socket');
  });

  it('names every kind', () => {
    for (const v of Object.values(WATCH_KIND_LABEL)) expect(v.length).toBeGreaterThan(0);
  });
});
