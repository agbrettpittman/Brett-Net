import { describe, expect, it } from 'vitest';
import {
  applyPaste,
  emptyRow,
  isEmptyRow,
  looksLikeHeader,
  normaliseColor,
  parseDelimited,
  readClipboard,
  toCsv,
  validateRows,
  type GridRow,
} from './grid';
import type { HostSpec } from './ipc';

const row = (host = '', name = '', color = '', port = ''): GridRow => ({
  host,
  name,
  color,
  port,
});

describe('parseDelimited', () => {
  it('splits a plain CSV block', () => {
    expect(parseDelimited('a,b\nc,d', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps a delimiter inside a quoted field', () => {
    // The case that makes a naive split wrong, and the reason names with
    // commas can still round-trip through CSV.
    expect(parseDelimited('8.8.8.8,"Site A, floor 2"', ',')).toEqual([
      ['8.8.8.8', 'Site A, floor 2'],
    ]);
  });

  it('unescapes a doubled quote', () => {
    expect(parseDelimited('a,"say ""hi"""', ',')).toEqual([['a', 'say "hi"']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseDelimited('a,"one\ntwo"', ',')).toEqual([['a', 'one\ntwo']]);
  });

  it('treats a quote that is not at the start of a field as literal', () => {
    expect(parseDelimited('12"pipe,b', ',')).toEqual([['12"pipe', 'b']]);
  });

  it('handles CRLF, bare LF and bare CR alike', () => {
    for (const nl of ['\r\n', '\n', '\r']) {
      expect(parseDelimited(`a${nl}b`, ',')).toEqual([['a'], ['b']]);
    }
  });

  it('drops the empty row a trailing newline leaves behind', () => {
    expect(parseDelimited('a,b\n', ',')).toEqual([['a', 'b']]);
  });

  it('splits on tabs when asked', () => {
    expect(parseDelimited('a\tb', '\t')).toEqual([['a', 'b']]);
  });
});

describe('readClipboard', () => {
  it('prefers tabs when any are present, because that is what Excel sends', () => {
    expect(readClipboard('8.8.8.8\tGoogle, Inc.')).toEqual([['8.8.8.8', 'Google, Inc.']]);
  });

  it('falls back to commas', () => {
    expect(readClipboard('8.8.8.8,Google')).toEqual([['8.8.8.8', 'Google']]);
  });

  it('strips a header row', () => {
    expect(readClipboard('host,name,color,port\n8.8.8.8,Google,,')).toEqual([
      ['8.8.8.8', 'Google', '', ''],
    ]);
  });

  it('keeps a single row even if it looks like a header', () => {
    // One row is the whole paste; dropping it would silently do nothing.
    expect(readClipboard('host,name')).toEqual([['host', 'name']]);
  });
});

describe('looksLikeHeader', () => {
  it('needs two matches, so a host actually called "name" is safe', () => {
    expect(looksLikeHeader(['name', '10.0.0.5'])).toBe(false);
    expect(looksLikeHeader(['host', 'name'])).toBe(true);
    expect(looksLikeHeader(['Target', 'Label', 'Colour'])).toBe(true);
  });

  it('does not fire on data', () => {
    expect(looksLikeHeader(['8.8.8.8', 'Google DNS', '', '443'])).toBe(false);
  });
});

describe('applyPaste', () => {
  it('fills outward from the focused cell', () => {
    const got = applyPaste([emptyRow(), emptyRow()], 0, 1, [['Gateway'], ['Router']]);
    expect(got[0]!.name).toBe('Gateway');
    expect(got[1]!.name).toBe('Router');
    expect(got[0]!.host).toBe('');
  });

  it('grows the grid to fit', () => {
    const got = applyPaste([emptyRow()], 0, 0, [['a'], ['b'], ['c']]);
    expect(got).toHaveLength(3);
    expect(got[2]!.host).toBe('c');
  });

  it('drops columns past the last rather than wrapping them', () => {
    // Wrapping would quietly put a port into the next row's host.
    const got = applyPaste([emptyRow()], 0, 3, [['443', 'extra']]);
    expect(got[0]!.port).toBe('443');
    expect(got).toHaveLength(1);
  });

  it('does not mutate the rows it was given', () => {
    const before = [emptyRow()];
    applyPaste(before, 0, 0, [['8.8.8.8']]);
    expect(before[0]!.host).toBe('');
  });
});

describe('normaliseColor', () => {
  it('accepts hex with or without a hash, and expands shorthand', () => {
    expect(normaliseColor('#4F8EF7')).toBe('#4f8ef7');
    expect(normaliseColor('4f8ef7')).toBe('#4f8ef7');
    expect(normaliseColor('#abc')).toBe('#aabbcc');
  });

  it('rejects anything else', () => {
    for (const bad of ['red', '#12', '#12345', 'xyzxyz', '']) {
      expect(normaliseColor(bad), bad).toBeNull();
    }
  });
});

describe('validateRows', () => {
  it('ignores blank rows without complaining', () => {
    // The grid always keeps a spare row to type into.
    expect(validateRows([emptyRow(), emptyRow()])).toEqual({ hosts: [], issues: [] });
  });

  it('defaults the name to the host and leaves probe and colour unset', () => {
    const { hosts, issues } = validateRows([row('8.8.8.8')]);
    expect(issues).toEqual([]);
    expect(hosts).toEqual([{ label: '8.8.8.8', target: '8.8.8.8' }]);
  });

  it('builds a TCP host when a port is given', () => {
    const { hosts } = validateRows([row('intranet', 'Intranet', '#abc', '443')]);
    expect(hosts[0]).toEqual({
      label: 'Intranet',
      target: 'intranet',
      probe: { mode: 'tcp', port: 443 },
      color: '#aabbcc',
    });
  });

  it('expands a CIDR range, sharing the colour and port', () => {
    const { hosts } = validateRows([row('10.0.0.0/30', 'Office', '#abc', '443')]);
    expect(hosts).toHaveLength(2);
    // A single typed name cannot serve many addresses, so each keeps its own.
    expect(hosts.map((h) => h.label)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(hosts.every((h) => h.color === '#aabbcc')).toBe(true);
    expect(hosts.every((h) => h.probe?.mode === 'tcp')).toBe(true);
  });

  it('keeps the same address on two ports as two hosts', () => {
    // The bug the port-aware dedup key exists to prevent.
    const { hosts } = validateRows([row('10.0.0.1'), row('10.0.0.1', '', '', '443')]);
    expect(hosts).toHaveLength(2);
  });

  it('drops an exact duplicate', () => {
    const { hosts } = validateRows([row('10.0.0.1'), row('10.0.0.1')]);
    expect(hosts).toHaveLength(1);
  });

  it('reports a missing host against the host cell', () => {
    const { hosts, issues } = validateRows([row('', 'Nameless')]);
    expect(hosts).toEqual([]);
    expect(issues[0]).toMatchObject({ row: 0, column: 'host' });
  });

  it('reports a bad port and a bad colour against their own cells', () => {
    const port = validateRows([row('10.0.0.1', '', '', '70000')]).issues[0];
    expect(port).toMatchObject({ row: 0, column: 'port' });
    const color = validateRows([row('10.0.0.1', '', 'nope', '')]).issues[0];
    expect(color).toMatchObject({ row: 0, column: 'color' });
  });

  it('numbers issues by their row in the grid', () => {
    const { issues } = validateRows([row('8.8.8.8'), row('999.1.1.1')]);
    expect(issues[0]!.row).toBe(1);
    expect(issues[0]!.message).toMatch(/^Row 2:/);
  });
});

describe('toCsv', () => {
  const host = (over: Partial<HostSpec>): HostSpec => ({
    id: 'x',
    label: 'L',
    target: 'T',
    ...over,
  });

  it('writes a header and one row per host', () => {
    const csv = toCsv([host({ target: '8.8.8.8', label: 'Google' })]);
    expect(csv).toBe('host,name,color,port\r\n8.8.8.8,Google,,');
  });

  it('includes colour and TCP port', () => {
    const csv = toCsv([
      host({ target: 'i', label: 'I', color: '#abcdef', probe: { mode: 'tcp', port: 443 } }),
    ]);
    expect(csv.split('\r\n')[1]).toBe('i,I,#abcdef,443');
  });

  it('quotes a name containing a comma', () => {
    const csv = toCsv([host({ target: 'a', label: 'Site A, floor 2' })]);
    expect(csv.split('\r\n')[1]).toBe('a,"Site A, floor 2",,');
  });

  it('round-trips through the clipboard reader', () => {
    // The whole point: a list copied on one machine pastes into another.
    const hosts = [
      host({ target: '8.8.8.8', label: 'Site A, floor 2' }),
      host({ target: 'i', label: 'I', color: '#abcdef', probe: { mode: 'tcp', port: 443 } }),
    ];
    const back = validateRows(
      applyPaste([emptyRow()], 0, 0, readClipboard(toCsv(hosts))),
    ).hosts;

    expect(back).toEqual([
      { label: 'Site A, floor 2', target: '8.8.8.8' },
      { label: 'I', target: 'i', probe: { mode: 'tcp', port: 443 }, color: '#abcdef' },
    ]);
  });
});

describe('isEmptyRow', () => {
  it('treats whitespace as empty', () => {
    expect(isEmptyRow(row('  ', '', '  ', ''))).toBe(true);
    expect(isEmptyRow(row('a'))).toBe(false);
  });
});
