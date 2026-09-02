import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  clearDiagnoses,
  clearWatchEvents,
  diagnose,
  diagnoses,
  listConnections,
  onDiagEvent,
  onWatchEvent,
  setWatches,
  stopDiagnosis,
  watchEvents,
} from '../../lib/ipc';
import {
  applyDiagEvent,
  CONCLUSION_LABEL,
  CONCLUSION_SUMMARY,
  isProblem,
  OUTCOME_MARK,
  type DiagReport,
  type DiagRun,
  type DiagStep,
} from '../../lib/diagnosis';
import {
  countByState,
  DEFAULT_FILTER,
  endpoint,
  filterConnections,
  groupConnections,
  isFault,
  isWatched,
  sortConnections,
  VERDICT_LABEL,
  watchFor,
  watchKind,
  WATCH_KIND_LABEL,
  type Connection,
  type WatchEvent,
  type WatchKind,
  type WatchSpec,
} from '../../lib/connections';
import { readBoolean, write } from '../../lib/prefs';

const ESTABLISHED_KEY = 'connections.establishedOnly';
const LOOPBACK_KEY = 'connections.hideLoopback';
const GROUPED_KEY = 'connections.grouped';
const WATCHES_KEY = 'connections.watches';

/** How often the table is re-read while the tab is showing. */
const POLL_MS = 2000;

function loadWatches(): WatchSpec[] {
  try {
    const raw = localStorage.getItem(WATCHES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as WatchSpec[]) : [];
  } catch {
    // A corrupt entry must not take the tab down with it.
    return [];
  }
}

/**
 * Every open TCP connection, and the process behind it.
 *
 * The table only refreshes while this tab is showing — there is no cumulative
 * state to lose, unlike the bandwidth totals. **Watching is separate and always
 * runs**, in Rust, because the whole point is catching a drop you were not
 * looking at.
 */
export function ConnectionsView({ active }: { active: boolean }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [establishedOnly, setEstablishedOnly] = useState(() =>
    readBoolean(localStorage, ESTABLISHED_KEY, DEFAULT_FILTER.establishedOnly),
  );
  const [hideLoopback, setHideLoopback] = useState(() =>
    readBoolean(localStorage, LOOPBACK_KEY, DEFAULT_FILTER.hideLoopback),
  );
  const [grouped, setGrouped] = useState(() => readBoolean(localStorage, GROUPED_KEY, true));
  const [watches, setWatchList] = useState<WatchSpec[]>(loadWatches);
  const [events, setEvents] = useState<WatchEvent[]>([]);
  const [reports, setReports] = useState<DiagReport[]>([]);
  /** The diagnosis in flight, rung by rung. */
  const [run, setRun] = useState<DiagRun | null>(null);

  /** Guards against a slow reply overwriting a newer one. */
  const request = useRef(0);

  const refresh = useCallback(() => {
    const ticket = (request.current += 1);
    listConnections()
      .then((c) => {
        if (request.current !== ticket) return;
        setConnections(c);
        setError(null);
      })
      .catch((e: unknown) => {
        if (request.current === ticket) setError(String(e));
      });
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [active, refresh]);

  // Push the whole list on every change, including the restored one at startup.
  // `prefs.write` only handles primitives, so this one is stored as JSON.
  useEffect(() => {
    localStorage.setItem(WATCHES_KEY, JSON.stringify(watches));
    setWatches(watches).catch((e: unknown) => setError(String(e)));
  }, [watches]);

  useEffect(() => {
    watchEvents().then(setEvents).catch(() => {});

    let unlisten: UnlistenFn | undefined;
    onWatchEvent((e) => setEvents((prev) => [...prev, e]))
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // Diagnoses run in Rust whether or not this tab is open, so the listener is
  // mounted once and the reports are read back on load.
  useEffect(() => {
    diagnoses().then(setReports).catch(() => {});

    let unlisten: UnlistenFn | undefined;
    onDiagEvent((e) => {
      setRun((prev) => applyDiagEvent(prev, e));
      if (e.event === 'done') setReports((prev) => [...prev, e.report]);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  const toggleWatch = useCallback((c: Connection, kind: WatchKind) => {
    const spec = watchFor(c, kind);
    if (spec === null) return;
    setWatchList((prev) =>
      prev.some((w) => w.id === spec.id) ? prev.filter((w) => w.id !== spec.id) : [...prev, spec],
    );
  }, []);

  const all = connections ?? [];
  const filtered = useMemo(
    () => sortConnections(filterConnections(all, { search, establishedOnly, hideLoopback })),
    [all, search, establishedOnly, hideLoopback],
  );
  const rows = useMemo(
    () =>
      grouped
        ? groupConnections(filtered)
        : filtered.map((c) => ({ key: c.id, lead: c, members: [c] })),
    [filtered, grouped],
  );
  const established = countByState(all).get('Established') ?? 0;

  /** Which watches currently have a live connection behind them. */
  const liveWatches = useMemo(() => {
    const up = new Set<string>();
    for (const c of all) {
      if (c.state !== 'Established') continue;
      for (const kind of ['process', 'peer', 'socket'] as const) {
        const spec = watchFor(c, kind);
        if (spec) up.add(spec.id);
      }
    }
    return up;
  }, [all]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-2.5 text-xs">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by process, address or port"
          spellCheck={false}
          aria-label="Filter connections"
          className="w-64 rounded-md border border-border bg-bg px-2.5 py-1 outline-none focus:border-accent"
        />
        <Check
          label="Established only"
          checked={establishedOnly}
          onChange={(on) => {
            write(localStorage, ESTABLISHED_KEY, on);
            setEstablishedOnly(on);
          }}
        />
        <Check
          label="Hide loopback"
          checked={hideLoopback}
          onChange={(on) => {
            write(localStorage, LOOPBACK_KEY, on);
            setHideLoopback(on);
          }}
        />
        <Check
          label="Group pooled"
          checked={grouped}
          onChange={(on) => {
            write(localStorage, GROUPED_KEY, on);
            setGrouped(on);
          }}
        />
        <span className="ml-auto text-text-muted">
          {rows.length} shown · {established} established · {all.length} total
        </span>
      </div>

      {error && (
        <p className="mx-5 mt-3 shrink-0 rounded-md border border-danger/40 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </p>
      )}

      {watches.length > 0 && (
        <Watched
          watches={watches}
          live={liveWatches}
          events={events}
          reports={reports}
          run={run}
          onRemove={(id) => setWatchList((prev) => prev.filter((w) => w.id !== id))}
          onDiagnose={(id) => {
            setError(null);
            diagnose(id).catch((e: unknown) => setError(String(e)));
          }}
          onStop={() => {
            stopDiagnosis().catch(() => {});
          }}
          onClear={() => {
            clearWatchEvents().catch(() => {});
            clearDiagnoses().catch(() => {});
            setEvents([]);
            setReports([]);
            setRun(null);
          }}
        />
      )}

      <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
        {connections === null && !error && (
          <p className="pt-10 text-center text-xs text-text-muted">Reading connections…</p>
        )}

        {connections !== null && rows.length === 0 && (
          <p className="pt-10 text-center text-xs text-text-muted">
            {all.length === 0
              ? 'No TCP connections found.'
              : 'Nothing matches. Widen the filters above.'}
          </p>
        )}

        {rows.length > 0 && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-text-muted">
                <th className="pb-2 font-medium">Process</th>
                <th className="pb-2 font-medium">Local</th>
                <th className="pb-2 font-medium">Remote</th>
                <th className="pb-2 font-medium">State</th>
                <th className="pb-2 text-right font-medium">Watch</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, lead: c, members }) => {
                const n = members.length;
                return (
                  <tr key={key} className="group border-t border-border">
                    <td className="py-1.5 pr-4">
                      <span className="flex items-baseline gap-1.5">
                        <span>{c.process ?? <span className="text-text-muted">unknown</span>}</span>
                        {n > 1 ? (
                          <span
                            className="rounded border border-border px-1 text-[10px] text-text-muted"
                            title={`${n} pooled connections to this peer`}
                          >
                            ×{n}
                          </span>
                        ) : (
                          <span className="font-mono text-[10px] text-text-muted">{c.pid}</span>
                        )}
                        {c.v6 && (
                          <span
                            className="rounded border border-border px-1 text-[10px] text-text-muted"
                            title="IPv6"
                          >
                            v6
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-text-muted" data-selectable>
                      {/* Pooled sockets share the local address but not the port. */}
                      {n > 1 ? c.localAddr : endpoint(c.localAddr, c.localPort, c.v6)}
                    </td>
                    <td className="py-1.5 pr-4 font-mono" data-selectable>
                      {c.state === 'Listen' ? (
                        <span className="text-text-muted">listening</span>
                      ) : (
                        endpoint(c.remoteAddr, c.remotePort, c.v6)
                      )}
                    </td>
                    <td className="py-1.5 pr-4 text-text-muted">{c.state}</td>
                    <td className="py-1.5 text-right">
                      {/* Listeners have no peer to watch. */}
                      {c.state !== 'Listen' && (
                        <span className="flex justify-end gap-1">
                          {/* Widest first, so the row reads left to right as
                              progressively narrower. */}
                          {c.process !== null && (
                            <WatchButton
                              on={isWatched(watches, c, 'process')}
                              onClick={() => toggleWatch(c, 'process')}
                              label="Process"
                              title={`Watch whether ${c.process} is talking to anything at all. Survives it moving between peers.`}
                            />
                          )}
                          <WatchButton
                            on={isWatched(watches, c, 'peer')}
                            onClick={() => toggleWatch(c, 'peer')}
                            label="Peer"
                            title={`Watch whether ${c.process ?? 'this process'} is still talking to ${endpoint(c.remoteAddr, c.remotePort, c.v6)}. Survives the pool replacing individual sockets.`}
                          />
                          {/* One socket among a pool is not a meaningful thing to
                              pin — the peer watch is what you want there. */}
                          {n === 1 && (
                            <WatchButton
                              on={isWatched(watches, c, 'socket')}
                              onClick={() => toggleWatch(c, 'socket')}
                              label="Socket"
                              title="Watch this exact connection. Any reconnect counts as a drop."
                            />
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Watched({
  watches,
  live,
  events,
  reports,
  run,
  onRemove,
  onDiagnose,
  onStop,
  onClear,
}: {
  watches: WatchSpec[];
  live: Set<string>;
  events: WatchEvent[];
  reports: DiagReport[];
  run: DiagRun | null;
  onRemove: (id: string) => void;
  onDiagnose: (id: string) => void;
  onStop: () => void;
  onClear: () => void;
}) {
  // Newest first: the thing that just happened is the thing you came to read.
  const recent = [...events].reverse().slice(0, 8);
  const finished = [...reports].reverse().slice(0, 4);
  const running = run !== null && run.conclusion === null;

  return (
    <section className="max-h-[45%] shrink-0 overflow-auto border-b border-border bg-surface px-5 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Watching</span>
        {(events.length > 0 || reports.length > 0) && (
          <button
            onClick={onClear}
            className="rounded-md border border-border px-2 py-0.5 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            Clear log
          </button>
        )}
      </div>

      <ul className="mt-2 space-y-1">
        {watches.map((w) => {
          const up = live.has(w.id);
          return (
            <li key={w.id} className="flex items-center gap-2 text-xs">
              <span
                className={`inline-block size-2 shrink-0 rounded-full ${up ? 'bg-ok' : 'bg-danger'}`}
                title={up ? 'Connected' : 'Not connected'}
              />
              <span className="font-mono">{w.label}</span>
              <span className="text-text-muted">{WATCH_KIND_LABEL[watchKind(w)].toLowerCase()}</span>
              <button
                onClick={() => onDiagnose(w.id)}
                disabled={running}
                title="Run the same checks a drop would trigger, without waiting for one."
                className="ml-auto rounded border border-border px-1.5 py-px text-[10px] text-text-muted transition-colors hover:text-text disabled:opacity-40"
              >
                Diagnose
              </button>
              <button
                onClick={() => onRemove(w.id)}
                aria-label={`Stop watching ${w.label}`}
                className="text-text-muted transition-colors hover:text-danger"
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>

      {running && run && (
        <div className="mt-3 rounded-md border border-border px-3 py-2">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="font-medium">Diagnosing</span>
            <span className="font-mono text-text-muted">{run.target ?? run.label}</span>
            <button
              onClick={onStop}
              className="ml-auto text-xs text-text-muted transition-colors hover:text-danger"
            >
              Stop
            </button>
          </div>
          <Steps steps={run.steps} />
          <p className="mt-1 text-xs text-text-muted">Checking…</p>
        </div>
      )}

      {finished.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {finished.map((r, i) => (
            <Diagnosis key={`${r.watchId}-${r.at}-${i}`} report={r} open={i === 0} />
          ))}
        </ul>
      )}

      {recent.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-border pt-2">
          {recent.map((e, i) => (
            <li key={`${e.watchId}-${e.at}-${i}`} className="flex items-baseline gap-2 text-xs">
              <span className="shrink-0 font-mono text-text-muted">
                {new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}
              </span>
              <span
                className={`shrink-0 rounded px-1 ${
                  e.up
                    ? 'text-ok'
                    : isFault(e.verdict)
                      ? 'text-danger'
                      : 'text-warn'
                }`}
              >
                {e.up ? 'Reconnected' : (e.verdict && VERDICT_LABEL[e.verdict]) || 'Dropped'}
              </span>
              <span className="font-mono text-text-muted">{e.label}</span>
              <span className="min-w-0 text-text-muted">{e.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const OUTCOME_COLOR = {
  pass: 'text-ok',
  fail: 'text-danger',
  skipped: 'text-text-muted',
  unsupported: 'text-text-muted',
} as const;

function Steps({ steps }: { steps: DiagStep[] }) {
  if (steps.length === 0) return null;

  return (
    <ul className="mt-1.5 space-y-0.5">
      {steps.map((s, i) => (
        <li key={`${s.kind}-${i}`} className="flex items-baseline gap-2 text-xs">
          <span className={`w-3 shrink-0 ${OUTCOME_COLOR[s.outcome]}`}>
            {OUTCOME_MARK[s.outcome]}
          </span>
          <span className="w-32 shrink-0 text-text-muted">{s.label}</span>
          <span className="min-w-0">{s.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One finished report.
 *
 * A `<details>` rather than managed state: the newest is open, the rest are one
 * line each until asked for, and neither needs anything remembered.
 */
function Diagnosis({ report, open }: { report: DiagReport; open: boolean }) {
  const fault = isProblem(report.conclusion);

  return (
    <li>
      <details open={open} className="group rounded-md border border-border px-3 py-1.5">
        <summary className="flex cursor-pointer list-none items-baseline gap-2 text-xs">
          <span className="shrink-0 text-text-muted transition-transform group-open:rotate-90">
            ▸
          </span>
          <span className="shrink-0 font-mono text-text-muted">
            {new Date(report.at).toLocaleTimeString(undefined, { hour12: false })}
          </span>
          <span className={`shrink-0 font-medium ${fault ? 'text-danger' : 'text-ok'}`}>
            {CONCLUSION_LABEL[report.conclusion]}
          </span>
          <span className="truncate font-mono text-text-muted">{report.label}</span>
          {report.manual && (
            <span
              className="ml-auto shrink-0 rounded border border-border px-1 text-[10px] text-text-muted"
              title="Run from the Diagnose button rather than by a drop"
            >
              manual
            </span>
          )}
        </summary>

        <p className="mt-1 text-xs text-text-muted">{CONCLUSION_SUMMARY[report.conclusion]}</p>
        <Steps steps={report.steps} />
      </details>
    </li>
  );
}

function WatchButton({
  on,
  onClick,
  label,
  title,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={`rounded border px-1.5 py-px text-[10px] transition-colors ${
        on
          ? 'border-accent text-accent'
          : 'border-transparent text-text-muted opacity-0 hover:border-border group-hover:opacity-100'
      }`}
    >
      {label}
    </button>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--accent)]"
      />
      <span className="text-text-muted">{label}</span>
    </label>
  );
}
