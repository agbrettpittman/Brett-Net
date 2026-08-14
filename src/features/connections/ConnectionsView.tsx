import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listConnections } from '../../lib/ipc';
import {
  countByState,
  DEFAULT_FILTER,
  endpoint,
  filterConnections,
  sortConnections,
  type Connection,
} from '../../lib/connections';
import { readBoolean, write } from '../../lib/prefs';

const ESTABLISHED_KEY = 'connections.establishedOnly';
const LOOPBACK_KEY = 'connections.hideLoopback';

/** How often the table is re-read. */
const POLL_MS = 2000;

/**
 * Every open TCP connection, and the process behind it.
 *
 * Answers "what is this machine actually talking to", which the ping graph
 * cannot — that shows the paths this app was told to watch, not the
 * conversations everything else is having.
 */
export function ConnectionsView() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [establishedOnly, setEstablishedOnly] = useState(() =>
    readBoolean(localStorage, ESTABLISHED_KEY, DEFAULT_FILTER.establishedOnly),
  );
  const [hideLoopback, setHideLoopback] = useState(() =>
    readBoolean(localStorage, LOOPBACK_KEY, DEFAULT_FILTER.hideLoopback),
  );

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
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const all = connections ?? [];
  const visible = useMemo(
    () => sortConnections(filterConnections(all, { search, establishedOnly, hideLoopback })),
    [all, search, establishedOnly, hideLoopback],
  );

  const established = countByState(all).get('Established') ?? 0;

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
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id} className="border-t border-border">
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
                    {/* A listener has no peer, and all-zeroes reads as data. */}
                    {c.state === 'Listen' ? (
                      <span className="text-text-muted">listening</span>
                    ) : (
                      endpoint(c.remoteAddr, c.remotePort, c.v6)
                    )}
                  </td>
                  <td className="py-1.5 text-text-muted">{c.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
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
