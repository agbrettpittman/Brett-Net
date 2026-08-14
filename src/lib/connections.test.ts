import { describe, expect, it } from 'vitest';
import {
  countByState,
  DEFAULT_FILTER,
  endpoint,
  filterConnections,
  isListener,
  isLoopback,
  sortConnections,
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
