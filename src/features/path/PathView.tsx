import { useCallback, useRef, useState } from 'react';
import {
  runTrace,
  stopTrace,
  TRACE_DEFAULTS,
  type TraceHop,
  type TraceOutcome,
} from '../../lib/ipc';
import { hopBest, hopLoss, hopNote, outcomeMessage } from '../../lib/trace';
import { formatMs } from '../../lib/stats';

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

  // Read inside the outcome message, which is built after the last state
  // update has been queued but before React has applied it.
  const collected = useRef<TraceHop[]>([]);

  const start = useCallback(() => {
    const t = target.trim();
    if (!t || running) return;

    collected.current = [];
    setHops([]);
    setResolved(null);
    setOutcome(null);
    setError(null);
    setRunning(true);

    runTrace(t, TRACE_DEFAULTS, (event) => {
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
          break;
      }
    })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setRunning(false));
  }, [target, running]);

  const stop = useCallback(() => {
    stopTrace().catch(() => {});
  }, []);

  const probes = TRACE_DEFAULTS.probes;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2.5 text-xs">
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
          className="w-64 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs outline-none focus:border-accent"
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
          <span className="ml-2 font-mono text-text-muted">→ {resolved.addr}</span>
        )}
        {running && <span className="text-text-muted">Tracing…</span>}
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
          <table className="w-full max-w-3xl text-xs">
            <thead>
              <tr className="text-left text-text-muted">
                <th className="pb-2 font-medium">#</th>
                <th className="pb-2 font-medium">Address</th>
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
                return (
                  <tr key={h.ttl} className="border-t border-border">
                    <td className="py-1.5 font-mono text-text-muted">{h.ttl}</td>
                    <td className="py-1.5 font-mono" data-selectable>
                      {h.addr ?? <span className="text-text-muted">no reply</span>}
                      {h.reached && (
                        <span className="ml-2 text-[11px] text-ok">target</span>
                      )}
                      {note && <span className="ml-2 text-[11px] text-warn">{note}</span>}
                    </td>
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
          <p className="mt-4 text-xs text-text-muted">{outcomeMessage(outcome, hops)}</p>
        )}
      </div>
    </div>
  );
}
