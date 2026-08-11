import { useEffect, useRef, useState } from 'react';
import type { HostSpec } from '../lib/ipc';
import { parseHostInput } from '../lib/parseHosts';
import { PALETTE_PREVIEW } from '../lib/palette';

interface Props {
  host: HostSpec;
  /** Colour this host would use if no override is set. */
  autoColor: string;
  onSave: (host: HostSpec) => void;
  onCancel: () => void;
}

export function EditHost({ host, autoColor, onSave, onCancel }: Props) {
  const [label, setLabel] = useState(host.label);
  const [target, setTarget] = useState(host.target);
  const [color, setColor] = useState<string | undefined>(host.color);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstField.current?.focus();
    firstField.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // A changed target restarts probing, so reject anything unresolvable up front.
  const targetError =
    target.trim() === ''
      ? 'Target is required'
      : (parseHostInput(target).errors[0] ?? null);
  const valid = label.trim() !== '' && targetError === null;

  function save() {
    if (!valid) return;
    onSave({ ...host, label: label.trim(), target: target.trim(), color });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${host.label}`}
        className="w-full max-w-sm rounded-[var(--radius)] border border-border bg-surface p-5 shadow-xl"
      >
        <h2 className="text-sm font-semibold">Edit host</h2>

        <label className="mt-4 block text-xs font-medium" htmlFor="edit-label">
          Name
        </label>
        <input
          id="edit-label"
          ref={firstField}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          className="mt-1 w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs outline-none focus:border-accent"
        />

        <label className="mt-3 block text-xs font-medium" htmlFor="edit-target">
          Target
        </label>
        <input
          id="edit-target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          spellCheck={false}
          className="mt-1 w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent"
        />
        {targetError && <p className="mt-1 text-xs text-warn">{targetError}</p>}

        <span className="mt-4 block text-xs font-medium">Colour</span>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setColor(undefined)}
            title="Automatic"
            aria-label="Automatic colour"
            className={`flex size-6 items-center justify-center rounded-md border text-[10px] ${
              color === undefined ? 'border-accent' : 'border-border'
            }`}
            style={{ color: autoColor }}
          >
            A
          </button>
          {PALETTE_PREVIEW.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              aria-label={`Colour ${c}`}
              className={`size-6 rounded-md border ${
                color === c ? 'border-accent' : 'border-transparent'
              }`}
              style={{ background: c }}
            />
          ))}
          <label className="ml-1 flex items-center gap-1 text-xs text-text-muted">
            <input
              type="color"
              value={color ?? '#4f8ef7'}
              onChange={(e) => setColor(e.target.value)}
              className="size-6 cursor-pointer rounded-md border border-border bg-transparent p-0"
            />
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!valid}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
