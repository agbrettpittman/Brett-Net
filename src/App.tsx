import { useCallback, useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  hostInfo,
  onPingTick,
  startMonitor,
  stopMonitor,
  STATUS_LABEL,
  type HostInfo,
  type HostSpec,
  type PingStatus,
} from './lib/ipc';
import { HostStats, formatMs } from './lib/stats';
import { AddHosts } from './components/AddHosts';

const DEFAULT_HOSTS: HostSpec[] = [
  { id: 'h-google-dns', label: 'Google DNS', target: '8.8.8.8' },
  { id: 'h-cloudflare', label: 'Cloudflare DNS', target: '1.1.1.1' },
  { id: 'h-google', label: 'google.com', target: 'google.com' },
];

const INTERVAL_MS = 1000;
const TIMEOUT_MS = 2000;
/** The chrome re-renders on a timer, not per tick, to keep React off the hot path. */
const REFRESH_MS = 500;

export default function App() {
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [hosts, setHosts] = useState<HostSpec[]>(DEFAULT_HOSTS);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(
    () => document.documentElement.dataset.theme ?? 'light',
  );

  // High-frequency data lives outside React state.
  const stats = useRef(new Map<string, HostStats>());
  const lastStatus = useRef(new Map<string, PingStatus>());
  const [, bumpFrame] = useState(0);

  useEffect(() => {
    hostInfo().then(setInfo).catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    onPingTick((tick) => {
      for (const r of tick.results) {
        let s = stats.current.get(r.hostId);
        if (!s) {
          s = new HostStats();
          stats.current.set(r.hostId, s);
        }
        s.add(r);
        lastStatus.current.set(r.hostId, r.status);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((e: unknown) => setError(String(e)));

    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => bumpFrame((n) => n + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [running]);

  const toggleRun = useCallback(async () => {
    setError(null);
    try {
      if (running) {
        await stopMonitor();
        setRunning(false);
      } else {
        stats.current.clear();
        lastStatus.current.clear();
        await startMonitor(hosts, INTERVAL_MS, TIMEOUT_MS);
        setRunning(true);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [running, hosts]);

  const addHosts = useCallback((added: HostSpec[]) => {
    setHosts((prev) => {
      const seen = new Set(prev.map((h) => h.target.toLowerCase()));
      return [...prev, ...added.filter((h) => !seen.has(h.target.toLowerCase()))];
    });
  }, []);

  const removeHost = useCallback((id: string) => {
    setHosts((prev) => prev.filter((h) => h.id !== id));
    stats.current.delete(id);
    lastStatus.current.delete(id);
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    setTheme(next);
  }

  // Derived from refs, so this recomputes on every render by design — the
  // render cadence is what throttles it, not memoisation.
  const all = [...stats.current.values()];
  const withAvg = all.filter((s) => s.avg !== null);
  const summary = {
    avg:
      withAvg.length === 0
        ? null
        : withAvg.reduce((a, s) => a + (s.avg ?? 0), 0) / withAvg.length,
    lossPct: (() => {
      const sent = all.reduce((a, s) => a + s.sent, 0);
      const lost = all.reduce((a, s) => a + s.lost, 0);
      return sent === 0 ? 0 : (lost / sent) * 100;
    })(),
    up: [...lastStatus.current.values()].filter((s) => s === 'success').length,
  };

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-[15px] font-semibold tracking-tight">Brett-Net</span>
          <span className="text-xs text-text-muted">
            {info ? `v${info.appVersion}` : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleRun}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              running
                ? 'bg-surface-2 text-text hover:bg-border'
                : 'bg-accent text-white hover:opacity-90'
            }`}
          >
            {running ? 'Stop' : 'Start'}
          </button>
          <button
            onClick={toggleTheme}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>

      <div className="flex items-center gap-8 border-b border-border px-5 py-2.5 text-xs">
        <Stat label="Avg" value={formatMs(summary.avg)} />
        <Stat label="Loss" value={`${summary.lossPct.toFixed(1)}%`} />
        <Stat label="Up" value={`${summary.up} / ${hosts.length}`} />
      </div>

      {error && (
        <p className="mx-5 mt-3 rounded-md border border-danger/40 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </p>
      )}

      <main className="flex-1 overflow-auto px-5 py-4">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="pb-2 font-medium">Host</th>
              <th className="pb-2 font-medium">Target</th>
              <th className="pb-2 text-right font-medium">Last</th>
              <th className="pb-2 text-right font-medium">Avg</th>
              <th className="pb-2 text-right font-medium">Jitter</th>
              <th className="pb-2 text-right font-medium">Loss</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {hosts.map((h) => {
              const s = stats.current.get(h.id);
              const status = lastStatus.current.get(h.id);
              return (
                <tr key={h.id} className="border-t border-border">
                  <td className="py-2">
                    <span className="flex items-center gap-2">
                      <StatusDot status={status} />
                      {h.label}
                    </span>
                  </td>
                  <td className="py-2 font-mono text-text-muted" data-selectable>
                    {h.target}
                  </td>
                  <td className="py-2 text-right font-mono">{formatMs(s?.last ?? null)}</td>
                  <td className="py-2 text-right font-mono">{formatMs(s?.avg ?? null)}</td>
                  <td className="py-2 text-right font-mono">{formatMs(s?.jitter ?? null)}</td>
                  <td className="py-2 text-right font-mono">
                    {s ? `${s.lossPct.toFixed(0)}%` : '—'}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => removeHost(h.id)}
                      className="text-text-muted transition-colors hover:text-danger"
                      aria-label={`Remove ${h.label}`}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {hosts.length === 0 && (
          <p className="py-8 text-center text-xs text-text-muted">
            No hosts yet. Add some below to start monitoring.
          </p>
        )}

        <AddHosts onAdd={addHosts} />
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-text-muted">{label}</span>
      <span className="font-mono">{value}</span>
    </span>
  );
}

function StatusDot({ status }: { status: PingStatus | undefined }) {
  const color =
    status === undefined
      ? 'bg-border'
      : status === 'success'
        ? 'bg-ok'
        : status === 'timedOut'
          ? 'bg-danger'
          : 'bg-warn';
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${color}`}
      title={status ? STATUS_LABEL[status] : 'No data'}
    />
  );
}
