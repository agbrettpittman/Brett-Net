import type { HostSpec, ProbeMode } from './ipc';
import { parseHostInput } from './parseHosts';
import { hostKey, parsePort } from './probeMode';

/** One row of the host entry grid, held as raw text so a half-typed cell is
 *  never destroyed by validation. */
export interface GridRow {
  host: string;
  name: string;
  color: string;
  port: string;
}

export const COLUMNS = ['host', 'name', 'color', 'port'] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
  host: 'Host',
  name: 'Name',
  color: 'Colour',
  port: 'TCP port',
};

/** A host the grid has validated. The id is assigned by the caller. */
export type NewHost = Omit<HostSpec, 'id'>;

export interface Issue {
  row: number;
  column: Column;
  message: string;
}

export function emptyRow(): GridRow {
  return { host: '', name: '', color: '', port: '' };
}

export function isEmptyRow(row: GridRow): boolean {
  return COLUMNS.every((c) => row[c].trim() === '');
}

/**
 * Splits delimited text into a rectangle of cells.
 *
 * A full parse rather than a split, because a quoted field may contain the
 * delimiter, a quote (doubled), or a newline — all of which Excel emits and a
 * naive split would tear apart.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i]!;

    if (quoted) {
      if (c === '"') {
        // A doubled quote is an escaped quote; a lone one closes the field.
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    // Only a quote at the very start of a field opens one, so a stray quote
    // mid-value stays literal instead of swallowing the rest of the paste.
    if (c === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r') {
      endRow();
      // Treat CRLF as one break, and a lone CR as a break in its own right.
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (c === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  endRow();
  // A trailing newline produces a final empty row that means nothing.
  while (rows.length > 1 && rows[rows.length - 1]!.every((v) => v === '')) rows.pop();
  return rows;
}

const HEADER_WORDS = new Set([
  'host',
  'target',
  'ip',
  'address',
  'name',
  'label',
  'color',
  'colour',
  'port',
  'tcp',
  'tcp port',
]);

/**
 * Whether a pasted first row is column headings rather than data.
 *
 * Two matches are required. One would misfire on a real host legitimately
 * called `name`, and a genuine header always has several.
 */
export function looksLikeHeader(cells: string[]): boolean {
  const hits = cells.filter((c) => HEADER_WORDS.has(c.trim().toLowerCase())).length;
  return hits >= 2;
}

/**
 * Turns clipboard text into cells.
 *
 * Excel puts tab-separated text on the clipboard and a text editor puts commas,
 * so the presence of a tab anywhere decides it. A comma inside a quoted field of
 * a tab-separated paste is therefore safe, which is the case that matters.
 */
export function readClipboard(text: string): string[][] {
  const cells = parseDelimited(text, text.includes('\t') ? '\t' : ',');
  if (cells.length > 1 && looksLikeHeader(cells[0]!)) cells.shift();
  return cells;
}

/**
 * Writes pasted cells into the grid starting at one cell.
 *
 * Filling outward from the focused cell is what a spreadsheet does, and it is
 * what makes pasting a single column of names into the Name field work. Rows
 * are grown as needed; columns past the last one are dropped rather than
 * silently shifting data into the wrong field.
 */
export function applyPaste(
  rows: GridRow[],
  atRow: number,
  atCol: number,
  cells: string[][],
): GridRow[] {
  const out: GridRow[] = rows.map((r) => ({ ...r }));
  while (out.length < atRow + cells.length) out.push(emptyRow());

  cells.forEach((cellRow, r) => {
    cellRow.forEach((value, c) => {
      const column = COLUMNS[atCol + c];
      if (!column) return;
      out[atRow + r]![column] = value.trim();
    });
  });
  return out;
}

/** Accepts `#4f8ef7`, `4f8ef7` and `#abc`, normalising to full six-digit form. */
export function normaliseColor(value: string): string | null {
  const hex = value.trim().replace(/^#/, '').toLowerCase();
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(hex)) return null;
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  return `#${full}`;
}

/**
 * Validates the grid and produces hosts ready to add.
 *
 * Empty rows are ignored rather than reported — the grid always keeps a blank
 * row at the bottom to type into, and complaining about it would be absurd.
 */
export function validateRows(rows: GridRow[]): { hosts: NewHost[]; issues: Issue[] } {
  const hosts: NewHost[] = [];
  const issues: Issue[] = [];
  const seen = new Set<string>();

  rows.forEach((row, i) => {
    if (isEmptyRow(row)) return;
    const at = (column: Column, message: string) =>
      issues.push({ row: i, column, message: `Row ${i + 1}: ${message}` });

    if (row.host.trim() === '') {
      at('host', 'a host is required');
      return;
    }

    let probe: ProbeMode | undefined;
    if (row.port.trim() !== '') {
      const parsed = parsePort(row.port);
      if ('error' in parsed) {
        at('port', parsed.error.toLowerCase());
        return;
      }
      probe = { mode: 'tcp', port: parsed.port };
    }

    let color: string | undefined;
    if (row.color.trim() !== '') {
      const normalised = normaliseColor(row.color);
      if (normalised === null) {
        at('color', `${row.color} is not a colour like #4f8ef7`);
        return;
      }
      color = normalised;
    }

    // Reuses the existing parser, so CIDR ranges still expand and hostname
    // validation stays in one place.
    const parsed = parseHostInput(row.host);
    for (const e of parsed.errors) at('host', e);

    const named = row.name.trim();
    for (const h of parsed.hosts) {
      const key = hostKey({ target: h.target, probe });
      if (seen.has(key)) continue;
      seen.add(key);

      hosts.push({
        // A CIDR expands to many addresses and one typed name cannot serve them
        // all, so a range keeps per-address labels.
        label: named && parsed.hosts.length === 1 ? named : h.label,
        target: h.target,
        ...(probe ? { probe } : {}),
        ...(color ? { color } : {}),
      });
    }
  });

  return { hosts, issues };
}

const CSV_HEADER = COLUMNS.join(',');

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The host list as CSV, in the same four columns the grid accepts, so a list
 * copied from one machine pastes straight into another.
 *
 * CRLF line endings because the main destination is Excel.
 */
export function toCsv(hosts: HostSpec[]): string {
  const lines = [CSV_HEADER];
  for (const h of hosts) {
    lines.push(
      [
        h.target,
        h.label,
        h.color ?? '',
        h.probe?.mode === 'tcp' ? String(h.probe.port) : '',
      ]
        .map(csvField)
        .join(','),
    );
  }
  return lines.join('\r\n');
}
