import { useEffect, useRef, useState } from 'react';
import { ICMP, type HostSpec } from '../lib/ipc';
import { parseHostInput } from '../lib/parseHosts';
import { PALETTE_PREVIEW } from '../lib/palette';
import { parsePort, probeOf } from '../lib/probeMode';

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
  const initial = probeOf(host);
  const [tcp, setTcp] = useState(initial.mode === 'tcp');
  const [port, setPort] = useState(initial.mode === 'tcp' ? String(initial.port) : '443');
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
  const parsedPort = parsePort(port);
  const portError = tcp && 'error' in parsedPort ? parsedPort.error : null;
  const valid = label.trim() !== '' && targetError === null && portError === null;

  function save() {
    if (!valid) return;
    onSave({
      ...host,
      label: label.trim(),
      target: target.trim(),
      probe: tcp && 'port' in parsedPort ? { mode: 'tcp', port: parsedPort.port } : ICMP,
      color,
    });
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

        <span className="mt-4 block text-xs font-medium">Probe with</span>
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5">
            {[
              { tcp: false, label: 'Ping' },
              { tcp: true, label: 'TCP port' },
            ].map((o) => (
              <button
                key={o.label}
                onClick={() => setTcp(o.tcp)}
                aria-pressed={tcp === o.tcp}
                className={`rounded px-2 py-0.5 text-xs transition-colors ${
                  tcp === o.tcp ? 'bg-surface-2 text-text' : 'text-text-muted hover:text-text'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          {tcp && (
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              inputMode="numeric"
              aria-label="Port"
              className="w-20 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-xs outline-none focus:border-accent"
            />
          )}
        </div>
        {portError ? (
          <p className="mt-1 text-xs text-warn">{portError}</p>
        ) : (
          <p className="mt-1 text-xs text-text-muted">
            {tcp
              ? 'Opens a TCP connection instead of pinging. Use this where ICMP is blocked — but a handshake is slower than a ping, so these times sit above the rest.'
              : 'Normal ICMP echo.'}
          </p>
        )}

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
