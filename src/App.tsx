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
import { SeriesStore } from './lib/series';
import { seriesStyle } from './lib/palette';
import { AddHosts } from './components/AddHosts';
import { LatencyChart } from './features/ping/LatencyChart';

const DEFAULT_HOSTS: HostSpec[] = [
  { id: 'h-google-dns', label: 'Google DNS', target: '8.8.8.8' },
  { id: 'h-cloudflare', label: 'Cloudflare DNS', target: '1.1.1.1' },
  { id: 'h-google', label: 'google.com', target: 'google.com' },
];

const INTERVAL_MS = 1000;
const TIMEOUT_MS = 2000;
/** One hour of history at a one-second interval. */
const HISTORY = 3600;
/** The chrome re-renders on a timer, not per tick, to keep React off the hot path. */
const REFRESH_MS = 500;

export default function App() {
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [hosts, setHosts] = useState<HostSpec[]>(DEFAULT_HOSTS);
  /** User intent. The Rust monitor is kept in sync with this and `hosts`. */
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(
    () => document.documentElement.dataset.theme ?? 'light',
  );

  // High-frequency data lives outside React state.
  const stats = useRef(new Map<string, HostStats>());
  const lastStatus = useRef(new Map<string, PingStatus>());
  const store = useRef(new SeriesStore(HISTORY));
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    hostInfo().then(setInfo).catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    onPingTick((tick) => {
      const column = new Map<string, number | null>();
      for (const r of tick.results) {
        let s = stats.current.get(r.hostId);
        if (!s) {
          s = new HostStats();
          stats.current.set(r.hostId, s);
        }
        s.add(r);
        lastStatus.current.set(r.hostId, r.status);
        // Only a genuine reply from the target is a latency point. Timeouts and
        // TTL-expired replies become gaps in the line.
        column.set(
          r.hostId,
          r.status === 'success' && r.rttUs !== null ? r.rttUs / 1000 : null,
        );
      }
      store.current.push(tick.t / 1000, column);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((e: unknown) => setError(String(e)));

    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setRevision((n) => n + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [enabled]);

  // Single owner of the Rust monitor. The scheduler spawns one task per host at
  // start, so it has to be restarted whenever the host list changes — otherwise
  // hosts added later are never probed, and removed ones are probed forever.
  // Monitoring is on by default: a monitoring tool should be monitoring when you
  // open it. Stop is one click.
  useEffect(() => {
    if (!enabled || hosts.length === 0) {
      stopMonitor().catch(() => {});
      return;
    }

    let cancelled = false;
    for (const h of hosts) store.current.addHost(h.id);
    startMonitor(hosts, INTERVAL_MS, TIMEOUT_MS).catch((e: unknown) => {
      if (!cancelled) setError(String(e));
    });

    return () => {
      cancelled = true;
    };
  }, [hosts, enabled]);

  const toggleRun = useCallback(() => {
    setError(null);
    if (!enabled) {
      // Resuming after a stop: drop history, otherwise the chart draws a
      // straight line straight across however long the pause lasted.
      stats.current.clear();
      lastStatus.current.clear();
      store.current.clear();
    }
    setEnabled(!enabled);
  }, [enabled]);

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
    store.current.removeHost(id);
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    setTheme(next);
  }

  // Derived from refs, so this recomputes every render by design — the render
  // cadence throttles it, not memoisation.
  const all = [...stats.current.values()];
  const withAvg = all.filter((s) => s.avg !== null);
  const sent = all.reduce((a, s) => a + s.sent, 0);
  const lost = all.reduce((a, s) => a + s.lost, 0);
  const summary = {
    avg:
      withAvg.length === 0
        ? null
        : withAvg.reduce((a, s) => a + (s.avg ?? 0), 0) / withAvg.length,
    lossPct: sent === 0 ? 0 : (lost / sent) * 100,
    up: [...lastStatus.current.values()].filter((s) => s === 'success').length,
  };

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
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
              enabled
                ? 'bg-surface-2 text-text hover:bg-border'
                : 'bg-accent text-white hover:opacity-90'
            }`}
          >
            {enabled ? 'Stop' : 'Start'}
          </button>
          <button
            onClick={toggleTheme}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-8 border-b border-border px-5 py-2.5 text-xs">
        <Stat label="Avg" value={formatMs(summary.avg)} />
        <Stat label="Loss" value={`${summary.lossPct.toFixed(1)}%`} />
        <Stat label="Up" value={`${summary.up} / ${hosts.length}`} />
      </div>

      {error && (
        <p className="mx-5 mt-3 shrink-0 rounded-md border border-danger/40 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </p>
      )}

      <section className="min-h-0 flex-1 px-2 py-2">
        {hosts.length > 0 ? (
          <LatencyChart
            store={store.current}
            hosts={hosts}
            theme={theme}
            revision={revision}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-text-muted">
            Add a host to start graphing.
          </div>
        )}
      </section>

      <section className="max-h-[38%] shrink-0 overflow-auto border-t border-border px-5 py-3">
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
            {hosts.map((h, i) => {
              const s = stats.current.get(h.id);
              const status = lastStatus.current.get(h.id);
              const style = seriesStyle(i, theme);
              return (
                <tr key={h.id} className="border-t border-border">
                  <td className="py-2">
                    <span className="flex items-center gap-2">
                      <Swatch style={style} />
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

        <AddHosts onAdd={addHosts} />
      </section>
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

/** Line-style key matching the chart: colour plus dash pattern. */
function Swatch({ style }: { style: { stroke: string; dash?: number[] } }) {
  return (
    <svg width="14" height="8" aria-hidden className="shrink-0">
      <line
        x1="0"
        y1="4"
        x2="14"
        y2="4"
        stroke={style.stroke}
        strokeWidth="2"
        strokeDasharray={style.dash?.join(' ')}
      />
    </svg>
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
