import { useState } from 'react';
import type { HostSpec } from '../lib/ipc';
import { parseHostInput } from '../lib/parseHosts';

let counter = 0;
function nextId(target: string) {
  counter += 1;
  return `h-${target}-${counter}`;
}

export function AddHosts({ onAdd }: { onAdd: (hosts: HostSpec[]) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const preview = text.trim() ? parseHostInput(text) : null;

  function submit() {
    if (!preview) return;
    setErrors(preview.errors);
    if (preview.hosts.length === 0) return;

    onAdd(
      preview.hosts.map((h) => ({
        id: nextId(h.target),
        label: h.label,
        target: h.target,
      })),
    );
    setText('');
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
      <label htmlFor="add-hosts" className="text-xs font-medium">
        Add hosts
      </label>
      <p className="mt-1 text-xs text-text-muted">
        Paste a list — IPs, hostnames, or a CIDR range like{' '}
        <code className="font-mono">192.168.1.0/24</code>. Separate with commas,
        spaces, or new lines. Use <code className="font-mono">Name=target</code>{' '}
        to label one.
      </p>

      <textarea
        id="add-hosts"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
        }}
        rows={3}
        spellCheck={false}
        placeholder={'8.8.8.8\nGateway=192.168.1.1\n10.0.0.0/29'}
        className="mt-3 w-full resize-y rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-xs outline-none focus:border-accent"
      />

      <div className="mt-2 flex items-center justify-between gap-4">
        <span className="text-xs text-text-muted">
          {preview
            ? `${preview.hosts.length} host${preview.hosts.length === 1 ? '' : 's'} ready`
            : 'Ctrl+Enter to add'}
        </span>
        <span className="flex gap-2">
          <button
            onClick={() => {
              setOpen(false);
              setText('');
              setErrors([]);
            }}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!preview || preview.hosts.length === 0}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Add
          </button>
        </span>
      </div>

      {errors.length > 0 && (
        <ul className="mt-2 space-y-1">
          {errors.map((e) => (
            <li key={e} className="text-xs text-warn">
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
