import { useCallback, useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  exportHistory,
  historySince,
  loadSettings,
  onPingTick,
  saveSettings,
  startMonitor,
  stopMonitor,
  STATUS_LABEL,
  type HistorySample,
  type HostSpec,
  type PingStatus,
} from '../../lib/ipc';
import { HostStats, formatMs } from '../../lib/stats';
import { latencyMs, toColumns } from '../../lib/backfill';
import { SeriesStore } from '../../lib/series';
import { seriesStyle } from '../../lib/palette';
import { hostKey, probeBadge } from '../../lib/probeMode';
import { toCsv } from '../../lib/grid';
import { nextSort, sortRows, type HostSortKey, type HostSortState } from '../../lib/hostSort';
import type { Theme } from '../../lib/theme';
import { AddHosts } from '../../components/AddHosts';
import { EditHost } from '../../components/EditHost';
import { LatencyChart } from './LatencyChart';
import { BUCKETS, SPANS } from '../../lib/aggregate';

const DEFAULT_HOSTS: HostSpec[] = [
  { id: 'h-google-dns', label: 'Google DNS', target: '8.8.8.8' },
  { id: 'h-cloudflare', label: 'Cloudflare DNS', target: '1.1.1.1' },
  { id: 'h-google', label: 'google.com', target: 'google.com' },
];

/** Selectable probe rates. */
const PROBE_RATES = [
  { ms: 250, label: '250ms' },
  { ms: 500, label: '500ms' },
  { ms: 1000, label: '1s' },
  { ms: 2000, label: '2s' },
  { ms: 5000, label: '5s' },
] as const;

/** How long ping history is kept on disk. */
const RETENTIONS = [
  { days: 1, label: '1 day' },
  { days: 3, label: '3 days' },
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
] as const;

const TIMEOUT_MS = 2000;
/** Samples retained per host in memory — an hour at one per second. */
const HISTORY = 3600;
/** The chrome re-renders on a timer, not per tick, to keep React off the hot path. */
const REFRESH_MS = 500;

/**
 * The ping tool: live latency chart, host table, and everything that feeds them.
 *
 * Stays mounted while other tabs are shown — unmounting would drop the sample
 * store and restart the monitor, so switching tabs would silently reset the
 * graph.
 */
export function PingView({ theme }: { theme: Theme }) {
  const [hosts, setHosts] = useState<HostSpec[]>(DEFAULT_HOSTS);
  /** User intent. The Rust monitor is kept in sync with this and `hosts`. */
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Transient confirmation, e.g. where an export landed. */
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<HostSpec | null>(null);
  /** Gates monitoring and saving until persisted settings have been read. */
  const [loaded, setLoaded] = useState(false);
  const [probeMs, setProbeMs] = useState(1000);
  const [bucketSec, setBucketSec] = useState(5);
  const [spanSec, setSpanSec] = useState(300);
  const [retentionDays, setRetentionDays] = useState(7);
  const [exporting, setExporting] = useState(false);
  /** Table sort. Null keeps the chart's own line order. Session-only. */
  const [sort, setSort] = useState<HostSortState | null>(null);

  // High-frequency data lives outside React state.
  const stats = useRef(new Map<string, HostStats>());
  const lastStatus = useRef(new Map<string, PingStatus>());
  const store = useRef(new SeriesStore(HISTORY));
  const [revision, setRevision] = useState(0);

  /**
   * Replays stored samples into the chart and the per-host statistics, so a
   * restart resumes where it left off rather than starting from a blank canvas.
   */
  const restore = useCallback((samples: HistorySample[]) => {
    for (const col of toColumns(samples, HISTORY)) {
      store.current.push(col.tSec, col.values);
    }
    // Feed the table too, otherwise the chart shows an hour of history beside
    // an average computed from the last two seconds.
    for (const s of samples) {
      let hs = stats.current.get(s.hostId);
      if (!hs) {
        hs = new HostStats();
        stats.current.set(s.hostId, hs);
      }
      hs.add({ hostId: s.hostId, rttUs: s.rttUs, status: s.status, from: null });
      lastStatus.current.set(s.hostId, s.status);
    }
  }, []);

  // Restore saved settings, then replay stored samples into the chart, and only
  // then allow probing to begin. Both orderings are load-bearing: probing early
  // would ping the defaults and then replace them, and back-filling after a live
  // tick had landed would push older columns behind newer ones, leaving the x
  // axis non-monotonic.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let restored = DEFAULT_HOSTS;
      let span = spanSec;

      try {
        const s = await loadSettings();
        if (s) {
          // An empty saved list is a real choice — someone removed every host.
          // Treating it as "nothing saved" would resurrect the defaults on the
          // next launch, undoing the deletion.
          if (Array.isArray(s.hosts)) {
            restored = s.hosts;
            setHosts(s.hosts);
          }
          if (s.probeMs) setProbeMs(s.probeMs);
          if (typeof s.bucketSec === 'number') setBucketSec(s.bucketSec);
          if (typeof s.spanSec === 'number') {
            span = s.spanSec;
            setSpanSec(s.spanSec);
          }
          if (typeof s.retentionDays === 'number') setRetentionDays(s.retentionDays);
        }
      } catch (e: unknown) {
        setError(String(e));
      }

      try {
        const samples = await historySince(
          restored.map((h) => h.id),
          Math.min(span || HISTORY, HISTORY),
          HISTORY,
        );
        if (!cancelled) restore(samples);
      } catch {
        // History is a convenience, not a requirement. If it is unavailable the
        // chart simply starts empty, and the error surfaces on export instead.
      }

      if (!cancelled) setLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
    // Runs once; `spanSec` is only read for its initial value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on change, debounced so dragging through select options does not
  // write on every keystroke. Never runs before the load completes.
  useEffect(() => {
    if (!loaded) return;
    const id = setTimeout(() => {
      saveSettings({ hosts, probeMs, bucketSec, spanSec, retentionDays }).catch(() => {});
    }, 400);
    return () => clearTimeout(id);
  }, [loaded, hosts, probeMs, bucketSec, spanSec, retentionDays]);

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
        column.set(r.hostId, latencyMs(r.status, r.rttUs));
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
    if (!loaded) return;
    if (!enabled || hosts.length === 0) {
      stopMonitor().catch(() => {});
      return;
    }

    let cancelled = false;
    for (const h of hosts) store.current.addHost(h.id);
    startMonitor(hosts, probeMs, TIMEOUT_MS, retentionDays).catch((e: unknown) => {
      if (!cancelled) setError(String(e));
    });

    return () => {
      cancelled = true;
    };
  }, [hosts, enabled, probeMs, retentionDays, loaded]);

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
      const seen = new Set(prev.map(hostKey));
      return [...prev, ...added.filter((h) => !seen.has(hostKey(h)))];
    });
  }, []);

  /**
   * Puts the host list on the clipboard in the same four columns the add grid
   * accepts, so a list can be handed to someone else and pasted straight in.
   */
  const copyHosts = useCallback(() => {
    setNotice(null);
    const csv = toCsv(hosts);
    if (!navigator.clipboard) {
      setError('This build cannot reach the clipboard.');
      return;
    }
    navigator.clipboard.writeText(csv).then(
      () => setNotice(`Copied ${hosts.length} host${hosts.length === 1 ? '' : 's'} as CSV.`),
      (e: unknown) => setError(`Could not copy to the clipboard: ${String(e)}`),
    );
  }, [hosts]);

  const saveHost = useCallback((updated: HostSpec) => {
    setHosts((prev) => prev.map((h) => (h.id === updated.id ? updated : h)));
    setEditing(null);
  }, []);

  const doExport = useCallback(() => {
    setExporting(true);
    setNotice(null);
    // Everything retained, not just what is on screen: the point of an export
    // is the history you can no longer see.
    exportHistory(0)
      .then(({ path, rows }) => {
        setNotice(`Exported ${rows.toLocaleString()} samples to ${path}`);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setExporting(false));
  }, []);

  const removeHost = useCallback((id: string) => {
    setHosts((prev) => prev.filter((h) => h.id !== id));
    stats.current.delete(id);
    lastStatus.current.delete(id);
    store.current.removeHost(id);
  }, []);

  const onSort = useCallback((key: HostSortKey) => setSort((prev) => nextSort(prev, key)), []);

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

  // The row's index in `hosts` is carried through the sort so the swatch colour
  // and the chart line stay in lockstep — `seriesStyle` is keyed on position.
  const rows = hosts.map((h, i) => {
    const s = stats.current.get(h.id);
    return {
      h,
      i,
      s,
      status: lastStatus.current.get(h.id),
      label: h.label,
      target: h.target,
      last: s?.last ?? null,
      avg: s?.avg ?? null,
      jitter: s?.jitter ?? null,
      lossPct: s ? s.lossPct : null,
    };
  });
  const ordered = sortRows(rows, sort);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-5 py-2.5 text-xs">
        <button
          onClick={toggleRun}
          className={`rounded-md px-3 py-1 font-medium transition-colors ${
            enabled
              ? 'bg-surface-2 text-text hover:bg-border'
              : 'bg-accent text-white hover:opacity-90'
          }`}
        >
          {enabled ? 'Stop' : 'Start'}
        </button>

        <Stat label="Avg" value={formatMs(summary.avg)} />
        <Stat label="Loss" value={`${summary.lossPct.toFixed(1)}%`} />
        <Stat label="Up" value={`${summary.up} / ${hosts.length}`} />

        <span className="ml-auto flex items-center gap-4">
          <Select
            label="Every"
            title="How often each host is probed"
            value={probeMs}
            onChange={setProbeMs}
            options={PROBE_RATES.map((r) => ({ value: r.ms, label: r.label }))}
          />
          <Select
            label="Average"
            title="Average samples into buckets to reveal trends"
            value={bucketSec}
            onChange={setBucketSec}
            options={BUCKETS.map((b) => ({ value: b.sec, label: b.label }))}
          />
          <Select
            label="Span"
            title="How much history the chart shows"
            value={spanSec}
            onChange={setSpanSec}
            options={SPANS.map((s) => ({ value: s.sec, label: s.label }))}
          />
          <Select
            label="Keep"
            title="How long ping history is kept on disk"
            value={retentionDays}
            onChange={setRetentionDays}
            options={RETENTIONS.map((r) => ({ value: r.days, label: r.label }))}
          />
          <button
            onClick={doExport}
            disabled={exporting}
            title="Write all stored history to a CSV in your Downloads folder"
            className="rounded-md border border-border px-2 py-0.5 transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </span>
      </div>

      {error && (
        <p className="mx-5 mt-3 shrink-0 rounded-md border border-danger/40 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </p>
      )}

      {notice && (
        <p className="mx-5 mt-3 flex shrink-0 items-start gap-2 rounded-md border border-border px-3 py-2 font-mono text-xs text-text-muted">
          <span className="min-w-0 flex-1 break-all" data-selectable>
            {notice}
          </span>
          <button
            onClick={() => setNotice(null)}
            className="shrink-0 transition-colors hover:text-text"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </p>
      )}

      <section className="min-h-0 flex-1 px-2 py-2">
        {hosts.length > 0 ? (
          <LatencyChart
            store={store.current}
            hosts={hosts}
            theme={theme}
            spanSec={spanSec}
            bucketSec={bucketSec}
            revision={revision}
          />
        ) : (
          <EmptyState />
        )}
      </section>

      <section className="max-h-[38%] shrink-0 overflow-auto border-t border-border px-5 py-3">
        {/* Column headings above no rows read as a loading state, not an
            empty one — the empty state on the chart says it already. */}
        <table className={`w-full text-xs ${hosts.length === 0 ? 'hidden' : ''}`}>
          <thead>
            <tr className="text-left text-text-muted">
              <Th label="Host" sortKey="host" sort={sort} onSort={onSort} />
              <Th label="Target" sortKey="target" sort={sort} onSort={onSort} />
              <Th label="Last" sortKey="last" align="right" sort={sort} onSort={onSort} />
              <Th label="Avg" sortKey="avg" align="right" sort={sort} onSort={onSort} />
              <Th label="Jitter" sortKey="jitter" align="right" sort={sort} onSort={onSort} />
              <Th label="Loss" sortKey="loss" align="right" sort={sort} onSort={onSort} />
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {ordered.map(({ h, i, s, status }) => {
              const auto = seriesStyle(i, theme);
              const style = h.color ? { stroke: h.color } : auto;
              const badge = probeBadge(h);
              return (
                <tr key={h.id} className="group border-t border-border">
                  <td className="py-2">
                    <span className="flex items-center gap-2">
                      <Swatch style={style} />
                      <StatusDot status={status} />
                      <button
                        onClick={() => setEditing(h)}
                        className="text-left transition-colors hover:text-accent"
                        title="Edit name, target, or colour"
                      >
                        {h.label}
                      </button>
                    </span>
                  </td>
                  <td className="py-2 font-mono text-text-muted">
                    <span data-selectable>{h.target}</span>
                    {/* A TCP-probed host measures a handshake rather than a
                        ping, so it must not look like every other row. */}
                    {badge && (
                      <span
                        className="ml-1.5 rounded border border-border px-1 py-px text-[10px] tracking-tight"
                        title="Probed by opening a TCP connection, not by pinging"
                      >
                        {badge}
                      </span>
                    )}
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
        <button
          onClick={copyHosts}
          disabled={hosts.length === 0}
          title="Copy the host list to the clipboard as CSV, ready to paste into Excel or send to someone"
          className="ml-2 mt-3 rounded-md border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
        >
          Copy hosts
        </button>
      </section>

      {editing && (
        <EditHost
          host={editing}
          autoColor={
            seriesStyle(
              Math.max(
                0,
                hosts.findIndex((h) => h.id === editing.id),
              ),
              theme,
            ).stroke
          }
          onSave={saveHost}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

interface SelectOption {
  value: number;
  label: string;
}

function Select({
  label,
  title,
  value,
  onChange,
  options,
}: {
  label: string;
  title: string;
  value: number;
  onChange: (v: number) => void;
  options: SelectOption[];
}) {
  return (
    <label className="flex items-center gap-1.5" title={title}>
      <span className="text-text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Shown when every host has been removed. Reached rarely — the app ships with
 * three defaults — but an empty chart with no explanation reads as broken.
 */
function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <svg
        width="34"
        height="34"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-border"
        aria-hidden
      >
        <path d="M2 13h4l3 7 4-16 3 9h6" />
      </svg>
      <p className="text-sm font-medium">No hosts yet</p>
      <p className="max-w-sm text-xs text-text-muted">
        Add something to ping and its latency will be graphed here, one line per
        host. Paste a whole list at once — IPs, hostnames, or a CIDR range.
      </p>
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

/** A sortable column heading. Clicking cycles off → ascending → descending. */
function Th({
  label,
  sortKey,
  align = 'left',
  sort,
  onSort,
}: {
  label: string;
  sortKey: HostSortKey;
  align?: 'left' | 'right';
  sort: HostSortState | null;
  onSort: (key: HostSortKey) => void;
}) {
  const active = sort?.key === sortKey;
  return (
    <th className={`pb-2 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 transition-colors hover:text-text ${
          active ? 'text-text' : ''
        }`}
      >
        {label}
        <span aria-hidden className="text-[9px] leading-none">
          {active ? (sort?.dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
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
