import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface HostInfo {
  appVersion: string;
  hostname: string;
  os: string;
}

export default function App() {
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(
    () => document.documentElement.dataset.theme ?? 'light',
  );

  useEffect(() => {
    invoke<HostInfo>('host_info')
      .then(setInfo)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    setTheme(next);
  }

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-[15px] font-semibold tracking-tight">Brett-Net</span>
          <span className="text-xs text-text-muted">
            {info ? `v${info.appVersion}` : ''}
          </span>
        </div>
        <button
          onClick={toggleTheme}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>

      <main className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-md rounded-[var(--radius)] border border-border bg-surface p-6">
          <h1 className="text-sm font-medium">Build chain verification</h1>
          <p className="mt-1 text-xs text-text-muted">
            Confirms the frontend, the Rust core, and IPC between them are all working.
          </p>

          {error && (
            <p className="mt-4 rounded-md border border-danger/40 px-3 py-2 font-mono text-xs text-danger">
              {error}
            </p>
          )}

          {info && (
            <dl className="mt-5 space-y-2 text-xs" data-selectable>
              <Row label="Hostname" value={info.hostname} />
              <Row label="OS" value={info.os} />
              <Row label="App version" value={info.appVersion} />
            </dl>
          )}

          {!info && !error && (
            <p className="mt-5 text-xs text-text-muted">Loading…</p>
          )}
        </div>
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border pb-2 last:border-0">
      <dt className="text-text-muted">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}
