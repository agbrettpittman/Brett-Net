import { useCallback, useRef, useState } from 'react';
import {
  lookupAsn,
  runTrace,
  stopProbe,
  TRACE_DEFAULTS,
  type AsnInfo,
  type TraceHop,
  type TraceOutcome,
} from '../../lib/ipc';
import {
  formatAsn,
  hopBest,
  hopLoss,
  hopNote,
  networkName,
  outcomeMessage,
} from '../../lib/trace';
import { formatMs } from '../../lib/stats';
import { readBoolean, readNumber, write } from '../../lib/prefs';

/**
 * Consecutive unanswered hops before the trace gives up.
 *
 * The right number depends entirely on the network — a path with several
 * deliberately quiet routers needs a higher one, and behind a firewall that
 * drops TTL-expired ICMP a lower one saves two minutes of waiting. "Never" is
 * `tracert`'s behaviour: walk all 30 regardless.
 */
const SILENT_LIMITS = [
  { value: 3, label: '3 silent hops' },
  { value: 5, label: '5 silent hops' },
  { value: 10, label: '10 silent hops' },
  { value: 0, label: 'Never' },
] as const;

const SILENT_KEY = 'path.silentLimit';
const ASN_KEY = 'path.lookupAsn';

/**
 * Traceroute view.
 *
 * Hops stream in as they are found, so a slow path fills the table gradually
 * instead of showing nothing for a minute and then everything at once.
 */
export function PathView() {
  const [target, setTarget] = useState('8.8.8.8');
  const [running, setRunning] = useState(false);
  const [hops, setHops] = useState<TraceHop[]>([]);
  const [resolved, setResolved] = useState<{ target: string; addr: string } | null>(null);
  const [outcome, setOutcome] = useState<TraceOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asn, setAsn] = useState<Map<string, AsnInfo>>(new Map());
  const [silentLimit, setSilentLimit] = useState(() =>
    readNumber(localStorage, SILENT_KEY, TRACE_DEFAULTS.silentLimit),
  );
  const [withAsn, setWithAsn] = useState(() => readBoolean(localStorage, ASN_KEY, true));

  // Read when the trace ends, before React has applied the last state update.
  const collected = useRef<TraceHop[]>([]);
  const withAsnRef = useRef(withAsn);
  withAsnRef.current = withAsn;

  /**
   * Names the networks once the path is known.
   *
   * Deliberately after the trace rather than per hop: one bulk query answers
   * every address at once, where a lookup per hop would be a dozen round trips
   * and would slow down the thing being measured.
   */
  const nameNetworks = useCallback((found: TraceHop[]) => {
    if (!withAsnRef.current) return;
    const ips = [...new Set(found.map((h) => h.addr).filter((a): a is string => a !== null))];
    if (ips.length === 0) return;

    lookupAsn(ips)
      .then((infos) => {
        setAsn((prev) => {
          const next = new Map(prev);
          for (const info of infos) next.set(info.ip, info);
          return next;
        });
      })
      // Port 43 may well be blocked. A trace without network names is still a
      // useful trace, so this is never surfaced as an error.
      .catch(() => {});
  }, []);

  const start = useCallback(() => {
    const t = target.trim();
    if (!t || running) return;

    collected.current = [];
    setHops([]);
    setResolved(null);
    setOutcome(null);
    setError(null);
    setRunning(true);

    runTrace(t, { ...TRACE_DEFAULTS, silentLimit }, (event) => {
      switch (event.kind) {
        case 'resolved':
          setResolved({ target: event.target, addr: event.addr });
          break;
        case 'hop': {
          const { kind: _kind, ...hop } = event;
          collected.current = [...collected.current, hop];
          setHops(collected.current);
          break;
        }
        case 'done':
          setOutcome(event.outcome);
          nameNetworks(collected.current);
          break;
      }
    })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setRunning(false));
  }, [target, running, silentLimit, nameNetworks]);

  const stop = useCallback(() => {
    stopProbe().catch(() => {});
  }, []);

  const changeSilentLimit = useCallback((v: number) => {
    write(localStorage, SILENT_KEY, v);
    setSilentLimit(v);
  }, []);

  const toggleAsn = useCallback((on: boolean) => {
    write(localStorage, ASN_KEY, on);
    setWithAsn(on);
  }, []);

  const probes = TRACE_DEFAULTS.probes;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-2.5 text-xs">
        <label htmlFor="trace-target" className="text-text-muted">
          Trace to
        </label>
        <input
          id="trace-target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') start();
          }}
          spellCheck={false}
          placeholder="hostname or IP"
          className="w-56 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs outline-none focus:border-accent"
        />
        {running ? (
          <button
            onClick={stop}
            className="rounded-md bg-surface-2 px-3 py-1 font-medium transition-colors hover:bg-border"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={start}
            disabled={!target.trim()}
            className="rounded-md bg-accent px-3 py-1 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Trace
          </button>
        )}

        {resolved && resolved.target !== resolved.addr && (
          <span className="font-mono text-text-muted">→ {resolved.addr}</span>
        )}
        {running && <span className="text-text-muted">Tracing…</span>}

        <span className="ml-auto flex items-center gap-4">
          <label
            className="flex items-center gap-1.5"
            title="Stop once this many hops in a row fail to answer. Never walks all 30, like tracert."
          >
            <span className="text-text-muted">Give up after</span>
            <select
              value={silentLimit}
              onChange={(e) => changeSilentLimit(Number(e.target.value))}
              className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs outline-none focus:border-accent"
            >
              {SILENT_LIMITS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label
            className="flex items-center gap-1.5"
            title="Look up the network operator for each public hop, via whois.cymru.com. Private and internal addresses are never sent."
          >
            <input
              type="checkbox"
              checked={withAsn}
              onChange={(e) => toggleAsn(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            <span className="text-text-muted">Look up networks</span>
          </label>
        </span>
      </div>

      {error && (
        <p className="mx-5 mt-3 shrink-0 rounded-md border border-danger/40 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
        {hops.length === 0 ? (
          <p className="pt-10 text-center text-xs text-text-muted">
            {running
              ? 'Waiting for the first hop…'
              : 'Traces the route to a host, one line per router along the way.'}
          </p>
        ) : (
          // Capped rather than full-width: stretched across a wide window the
          // numeric columns drift so far from the address that a row stops
          // reading as one hop.
          <table className="w-full max-w-5xl text-xs">
            <thead>
              <tr className="text-left text-text-muted">
                <th className="pb-2 font-medium">#</th>
                <th className="pb-2 font-medium">Address</th>
                {withAsn && <th className="pb-2 font-medium">Network</th>}
                <th className="pb-2 text-right font-medium">Best</th>
                <th className="pb-2 text-right font-medium">Loss</th>
                {Array.from({ length: probes }, (_, i) => (
                  <th key={i} className="pb-2 text-right font-medium">
                    #{i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hops.map((h) => {
                const note = hopNote(h.status);
                const loss = hopLoss(h.rttsUs);
                const net = h.addr === null ? undefined : asn.get(h.addr);
                return (
                  <tr key={h.ttl} className="border-t border-border">
                    <td className="py-1.5 pr-3 font-mono text-text-muted">{h.ttl}</td>
                    <td className="py-1.5 pr-4 font-mono" data-selectable>
                      {h.addr ?? <span className="text-text-muted">no reply</span>}
                      {h.reached && <span className="ml-2 text-[11px] text-ok">target</span>}
                      {note && <span className="ml-2 text-[11px] text-warn">{note}</span>}
                    </td>
                    {withAsn && (
                      <td className="py-1.5 pr-4" data-selectable>
                        {net ? (
                          <span className="flex items-baseline gap-2">
                            <span className="font-mono text-text-muted">
                              {formatAsn(net.asn)}
                            </span>
                            <span className="truncate">{networkName(net)}</span>
                          </span>
                        ) : (
                          // Blank rather than "—": a private hop having no
                          // public network is normal, not missing data.
                          ''
                        )}
                      </td>
                    )}
                    <td className="py-1.5 text-right font-mono">
                      {formatMs(hopBest(h.rttsUs))}
                    </td>
                    {/* No loss is the expected state, so it is left blank —
                        a column of "0%" is noise that hides the rows that
                        actually lost something. */}
                    <td
                      className={`py-1.5 text-right font-mono ${
                        loss === 1 ? 'text-text-muted' : 'text-warn'
                      }`}
                    >
                      {loss === 0 ? '' : `${Math.round(loss * 100)}%`}
                    </td>
                    {Array.from({ length: probes }, (_, i) => (
                      <td key={i} className="py-1.5 text-right font-mono text-text-muted">
                        {h.rttsUs[i] == null ? '*' : formatMs(h.rttsUs[i]! / 1000)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {outcome && (
          <p className="mt-4 max-w-5xl text-xs text-text-muted">
            {outcomeMessage(outcome, hops)}
          </p>
        )}
      </div>
    </div>
  );
}
