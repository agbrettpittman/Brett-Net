import { useEffect, useMemo, useRef, useState } from 'react';
import type { HostSpec } from '../lib/ipc';
import {
  applyPaste,
  COLUMNS,
  COLUMN_LABELS,
  emptyRow,
  isEmptyRow,
  normaliseColor,
  readClipboard,
  validateRows,
  type Column,
  type GridRow,
} from '../lib/grid';

let counter = 0;
function nextId(target: string) {
  counter += 1;
  return `h-${target}-${counter}`;
}

/** Keeps one blank row at the bottom, so there is always somewhere to type. */
function withSpare(rows: GridRow[]): GridRow[] {
  if (rows.length === 0) return [emptyRow()];
  return isEmptyRow(rows[rows.length - 1]!) ? rows : [...rows, emptyRow()];
}

const cellKey = (row: number, col: number) => `${row}:${col}`;

/**
 * Host entry as a small spreadsheet.
 *
 * The columns match the CSV format exactly, so a list can be pasted straight
 * from Excel (which puts tabs on the clipboard) or from a CSV opened in a text
 * editor, as well as typed by hand.
 */
export function AddHosts({ onAdd }: { onAdd: (hosts: HostSpec[]) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<GridRow[]>(() => [emptyRow()]);
  const [submitted, setSubmitted] = useState(false);

  const inputs = useRef(new Map<string, HTMLInputElement | null>());
  /** Set when the cell to focus does not exist yet, e.g. a row about to be added. */
  const pending = useRef<{ row: number; col: number } | null>(null);

  const { hosts, issues } = useMemo(() => validateRows(rows), [rows]);
  /** Problems are only surfaced after an attempt, so typing is not nagged at. */
  const blocked = submitted && issues.length > 0;

  // Issues are shown against their own cell as well as listed, so a bad port in
  // row 14 does not mean hunting for row 14.
  const flagged = useMemo(() => {
    const map = new Set<string>();
    for (const i of issues) map.add(`${i.row}:${i.column}`);
    return map;
  }, [issues]);

  useEffect(() => {
    const target = pending.current;
    if (!target) return;
    pending.current = null;
    const el = inputs.current.get(cellKey(target.row, target.col));
    el?.focus();
    el?.select();
  }, [rows]);

  function focusCell(row: number, col: number) {
    const el = inputs.current.get(cellKey(row, col));
    if (el) {
      el.focus();
      el.select();
      return;
    }
    // The row is being created by this same update; focus once it renders.
    pending.current = { row, col };
  }

  function update(row: number, column: Column, value: string) {
    setRows((prev) => withSpare(prev.map((r, i) => (i === row ? { ...r, [column]: value } : r))));
  }

  function removeRow(row: number) {
    setRows((prev) => withSpare(prev.filter((_, i) => i !== row)));
  }

  function advance(row: number, col: number) {
    if (col + 1 < COLUMNS.length) focusCell(row, col + 1);
    else focusCell(row + 1, 0);
  }

  function reset() {
    setRows([emptyRow()]);
    setSubmitted(false);
  }

  function submit() {
    setSubmitted(true);
    if (hosts.length === 0 || issues.length > 0) return;
    onAdd(hosts.map((h) => ({ ...h, id: nextId(h.target) })));
    reset();
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 rounded-md border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
      >
        + Add hosts
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-[var(--radius)] border border-border bg-surface p-4">
      <span className="text-xs font-medium">Add hosts</span>
      <p className="mt-1 text-xs text-text-muted">
        Type, or paste a block from Excel or a CSV. Comma and Tab move to the next
        box. Leave <span className="font-medium">TCP port</span> empty to ping;
        fill it in to check that port instead — the way to watch a host that
        blocks ping. A CIDR range like{' '}
        <code className="font-mono">192.168.1.0/24</code> in Host expands to every
        address in it.
      </p>

      <div className="mt-3 overflow-x-auto">
        <div className="min-w-[34rem]">
          <div className="grid grid-cols-[2fr_2fr_1.3fr_1fr_auto] gap-1.5 pb-1 text-xs text-text-muted">
            {COLUMNS.map((c) => (
              <span key={c}>{COLUMN_LABELS[c]}</span>
            ))}
            <span className="w-5" />
          </div>

          <div className="space-y-1.5">
            {rows.map((row, r) => (
              <div key={r} className="grid grid-cols-[2fr_2fr_1.3fr_1fr_auto] items-center gap-1.5">
                {COLUMNS.map((column, c) => (
                  <Cell
                    key={column}
                    column={column}
                    value={row[column]}
                    invalid={submitted && flagged.has(`${r}:${column}`)}
                    label={`${COLUMN_LABELS[column]}, row ${r + 1}`}
                    ref={(el) => {
                      inputs.current.set(cellKey(r, c), el);
                    }}
                    onChange={(v) => update(r, column, v)}
                    onKeyDown={(e) => {
                      if (e.key === ',') {
                        e.preventDefault();
                        advance(r, c);
                      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        submit();
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        focusCell(r + 1, c);
                      }
                    }}
                    onPaste={(e) => {
                      const cells = readClipboard(e.clipboardData.getData('text'));
                      // A single value is an ordinary paste; only a block of
                      // them should spill into neighbouring cells.
                      if (cells.length === 1 && cells[0]!.length === 1) return;
                      e.preventDefault();
                      setRows((prev) => withSpare(applyPaste(prev, r, c, cells)));
                    }}
                  />
                ))}
                <button
                  onClick={() => removeRow(r)}
                  disabled={rows.length === 1 && isEmptyRow(row)}
                  aria-label={`Remove row ${r + 1}`}
                  className="w-5 text-xs text-text-muted transition-colors hover:text-danger disabled:opacity-0"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-4">
        <span className="text-xs text-text-muted">
          {hosts.length > 0
            ? `${hosts.length} host${hosts.length === 1 ? '' : 's'} ready`
            : 'Ctrl+Enter to add'}
          {blocked && (
            <span className="text-warn">
              {' '}
              · {issues.length} to fix
            </span>
          )}
        </span>
        <span className="flex gap-2">
          <button
            onClick={() => {
              setOpen(false);
              reset();
            }}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            // Enabled on the first attempt even with problems, because that
            // click is what reveals them. Once they are on screen, staying
            // enabled would mean a button that visibly does nothing.
            disabled={hosts.length === 0 || blocked}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Add
          </button>
        </span>
      </div>

      {submitted && issues.length > 0 && (
        <ul className="mt-2 space-y-1">
          {issues.map((i) => (
            <li key={`${i.row}:${i.column}`} className="text-xs text-warn">
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CellProps {
  column: Column;
  value: string;
  invalid: boolean;
  label: string;
  ref: (el: HTMLInputElement | null) => void;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void;
}

const PLACEHOLDER: Record<Column, string> = {
  host: '8.8.8.8',
  name: 'optional',
  color: 'auto',
  port: 'ping',
};

function Cell({ column, value, invalid, label, ref, onChange, onKeyDown, onPaste }: CellProps) {
  const swatch = column === 'color' ? normaliseColor(value) : null;

  return (
    <span className="flex min-w-0 items-center gap-1">
      {column === 'color' && (
        <label
          className="relative size-4 shrink-0 rounded border border-border"
          style={swatch ? { background: swatch } : undefined}
          title="Pick a colour"
        >
          <input
            type="color"
            value={swatch ?? '#4f8ef7'}
            onChange={(e) => onChange(e.target.value)}
            aria-label={`Pick ${label}`}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
      )}
      <input
        ref={ref}
        value={value}
        aria-label={label}
        placeholder={PLACEHOLDER[column]}
        spellCheck={false}
        inputMode={column === 'port' ? 'numeric' : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className={`w-full min-w-0 rounded-md border bg-bg px-2 py-1 font-mono text-xs outline-none focus:border-accent ${
          invalid ? 'border-warn' : 'border-border'
        }`}
      />
    </span>
  );
}
