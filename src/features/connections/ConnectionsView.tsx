import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  clearWatchEvents,
  listConnections,
  onWatchEvent,
  setWatches,
  watchEvents,
} from '../../lib/ipc';
import {
  countByState,
  DEFAULT_FILTER,
  endpoint,
  filterConnections,
  isFault,
  isWatched,
  sortConnections,
  VERDICT_LABEL,
  watchFor,
  type Connection,
  type WatchEvent,
  type WatchSpec,
} from '../../lib/connections';
import { readBoolean, write } from '../../lib/prefs';

const ESTABLISHED_KEY = 'connections.establishedOnly';
const LOOPBACK_KEY = 'connections.hideLoopback';
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
  const [watches, setWatchList] = useState<WatchSpec[]>(loadWatches);
  const [events, setEvents] = useState<WatchEvent[]>([]);

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

  const toggleWatch = useCallback((c: Connection, kind: 'endpoint' | 'socket') => {
    const spec = watchFor(c, kind);
    setWatchList((prev) =>
      prev.some((w) => w.id === spec.id) ? prev.filter((w) => w.id !== spec.id) : [...prev, spec],
    );
  }, []);

  const all = connections ?? [];
  const visible = useMemo(
    () => sortConnections(filterConnections(all, { search, establishedOnly, hideLoopback })),
    [all, search, establishedOnly, hideLoopback],
  );
  const established = countByState(all).get('Established') ?? 0;

  /** Which watches currently have a live connection behind them. */
  const liveWatches = useMemo(() => {
    const up = new Set<string>();
    for (const c of all) {
      if (c.state !== 'Established') continue;
      up.add(watchFor(c, 'endpoint').id);
      up.add(watchFor(c, 'socket').id);
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
        <span className="ml-auto text-text-muted">
          {visible.length} shown · {established} established · {all.length} total
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
          onRemove={(id) => setWatchList((prev) => prev.filter((w) => w.id !== id))}
          onClear={() => {
            clearWatchEvents().catch(() => {});
            setEvents([]);
          }}
        />
      )}

      <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
        {connections === null && !error && (
          <p className="pt-10 text-center text-xs text-text-muted">Reading connections…</p>
        )}

        {connections !== null && visible.length === 0 && (
          <p className="pt-10 text-center text-xs text-text-muted">
            {all.length === 0
              ? 'No TCP connections found.'
              : 'Nothing matches. Widen the filters above.'}
          </p>
        )}

        {visible.length > 0 && (
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
              {visible.map((c) => (
                <tr key={c.id} className="group border-t border-border">
                  <td className="py-1.5 pr-4">
                    <span className="flex items-baseline gap-1.5">
                      <span>{c.process ?? <span className="text-text-muted">unknown</span>}</span>
                      <span className="font-mono text-[10px] text-text-muted">{c.pid}</span>
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
                    {endpoint(c.localAddr, c.localPort, c.v6)}
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
                        <WatchButton
                          on={isWatched(watches, c, 'endpoint')}
                          onClick={() => toggleWatch(c, 'endpoint')}
                          label="App"
                          title={`Watch whether ${c.process ?? 'this process'} is still talking to ${endpoint(c.remoteAddr, c.remotePort, c.v6)}. Survives the pool replacing individual sockets.`}
                        />
                        <WatchButton
                          on={isWatched(watches, c, 'socket')}
                          onClick={() => toggleWatch(c, 'socket')}
                          label="Socket"
                          title="Watch this exact connection. Any reconnect counts as a drop."
                        />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
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
  onRemove,
  onClear,
}: {
  watches: WatchSpec[];
  live: Set<string>;
  events: WatchEvent[];
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  // Newest first: the thing that just happened is the thing you came to read.
  const recent = [...events].reverse().slice(0, 8);

  return (
    <section className="max-h-[45%] shrink-0 overflow-auto border-b border-border bg-surface px-5 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Watching</span>
        {events.length > 0 && (
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
              <span className="text-text-muted">{w.socket ? 'socket' : 'app'}</span>
              <button
                onClick={() => onRemove(w.id)}
                aria-label={`Stop watching ${w.label}`}
                className="ml-auto text-text-muted transition-colors hover:text-danger"
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>

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
