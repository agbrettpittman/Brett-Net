import { useCallback, useMemo, useRef, useState } from 'react';
import {
  COMMON_PORTS,
  dnsLookup,
  scanPorts,
  stopTrace,
  type DnsResult,
  type PortResult,
  type PortState,
  type ScanSummary,
} from '../../lib/ipc';
import { estimateScanSeconds, parsePorts } from '../../lib/ports';
import { formatMs } from '../../lib/stats';
import { readNumber, write } from '../../lib/prefs';

const PORTS_KEY = 'dns.ports';
const TIMEOUT_KEY = 'dns.timeoutMs';

/**
 * Starting points for the port list.
 *
 * The wide ranges are the reason the scan is worth having — "what is this box
 * actually running" is not a question twelve common ports can answer.
 */
const PRESETS = [
  { label: 'Common', value: COMMON_PORTS },
  { label: 'Well-known (1-1024)', value: '1-1024' },
  { label: 'Common + registered (1-10000)', value: '1-10000' },
  { label: 'Everything (1-65535)', value: '1-65535' },
] as const;

/** Above this, the backend sends only open ports. Matches `SCAN_DETAIL_LIMIT`. */
const DETAIL_LIMIT = 64;

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${(mins / 60).toFixed(1)} hr`;
}

const TIMEOUTS = [
  { value: 500, label: '0.5s' },
  { value: 1000, label: '1s' },
  { value: 2000, label: '2s' },
  { value: 5000, label: '5s' },
] as const;

const STATE_LABEL: Record<PortState, string> = {
  open: 'Open',
  refused: 'Refused',
  filtered: 'No answer',
};

const STATE_HINT: Record<PortState, string> = {
  open: 'Something is listening.',
  refused: 'Nothing is listening — but the host answered, so it is up.',
  filtered: 'No answer at all. A firewall is dropping it, or the host is down.',
};

const STATE_COLOR: Record<PortState, string> = {
  open: 'text-ok',
  refused: 'text-warn',
  filtered: 'text-text-muted',
};

/**
 * Name resolution and TCP reachability.
 *
 * The two belong together: "what does this name point at" and "can I actually
 * reach it" are almost always asked in the same breath, and the port check
 * needs the lookup anyway.
 */
export function DnsView() {
  const [host, setHost] = useState('google.com');
  const [dns, setDns] = useState<DnsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  const [portsText, setPortsText] = useState(
    () => localStorage.getItem(PORTS_KEY) ?? COMMON_PORTS,
  );
  const [timeoutMs, setTimeoutMs] = useState(() =>
    readNumber(localStorage, TIMEOUT_KEY, 2000),
  );
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<PortResult[]>([]);
  const [scanned, setScanned] = useState<{ target: string; addr: string } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<{ counts: ScanSummary; openOnly: boolean } | null>(
    null,
  );

  const collected = useRef<PortResult[]>([]);
  // Memoised: `1-65535` is a legal input, and re-parsing 65,535 ports on every
  // render would make the whole tab crawl.
  const parsed = useMemo(() => parsePorts(portsText), [portsText]);
  const estimate = estimateScanSeconds(parsed.ports.length, timeoutMs);

  const lookup = useCallback(() => {
    const h = host.trim();
    if (!h || looking) return;
    setLooking(true);
    setError(null);
    setDns(null);

    dnsLookup(h)
      .then(setDns)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLooking(false));
  }, [host, looking]);

  const scan = useCallback(() => {
    const h = host.trim();
    if (!h || scanning || parsed.error) return;

    collected.current = [];
    setResults([]);
    setScanned(null);
    setProgress(null);
    setSummary(null);
    setError(null);
    setScanning(true);

    scanPorts(h, parsed.ports, timeoutMs, (event) => {
      switch (event.kind) {
        case 'resolved':
          setScanned({ target: event.target, addr: event.addr });
          setProgress({ done: 0, total: event.total });
          break;
        case 'port': {
          const { kind: _kind, ...result } = event;
          // Results arrive in completion order because the checks run
          // concurrently; sorting keeps the table stable as it fills.
          collected.current = [...collected.current, result].sort((a, b) => a.port - b.port);
          setResults(collected.current);
          break;
        }
        case 'progress':
          setProgress({ done: event.done, total: event.total });
          break;
        case 'done':
          setSummary({ counts: event.summary, openOnly: event.openOnly });
          break;
      }
    })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setScanning(false));
  }, [host, scanning, parsed.error, parsed.ports, timeoutMs]);

  const stop = useCallback(() => {
    stopTrace().catch(() => {});
  }, []);

  const changePorts = useCallback((v: string) => {
    write(localStorage, PORTS_KEY, v);
    setPortsText(v);
  }, []);

  const changeTimeout = useCallback((v: number) => {
    write(localStorage, TIMEOUT_KEY, v);
    setTimeoutMs(v);
  }, []);

  const busy = looking || scanning;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-2.5 text-xs">
        <label htmlFor="dns-host" className="text-text-muted">
          Host
        </label>
        <input
          id="dns-host"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') lookup();
          }}
          spellCheck={false}
          placeholder="hostname or IP"
          className="w-56 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs outline-none focus:border-accent"
        />
        <button
          onClick={lookup}
          disabled={!host.trim() || busy}
          className="rounded-md bg-accent px-3 py-1 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {looking ? 'Looking up…' : 'Look up'}
        </button>
      </div>

      {error && (
        <p className="mx-5 mt-3 shrink-0 rounded-md border border-danger/40 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
        {dns && (
          <section className="mb-6">
            <h2 className="mb-2 text-xs font-medium">
              {dns.host}
              <span className="ml-2 font-normal text-text-muted">
                resolved in {formatMs(dns.ms)}
              </span>
            </h2>
            <ul className="space-y-1">
              {dns.addresses.map((a, i) => (
                <li key={a} className="flex items-baseline gap-3 font-mono text-xs">
                  <span data-selectable>{a}</span>
                  {i === 0 && dns.addresses.length > 1 && (
                    // Worth calling out: this is the one a client will use.
                    <span className="text-[11px] text-text-muted">first</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <label htmlFor="dns-ports" className="text-text-muted">
              Ports
            </label>
            <input
              id="dns-ports"
              value={portsText}
              onChange={(e) => changePorts(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') scan();
              }}
              spellCheck={false}
              placeholder="80, 443, 8000-8010"
              className="w-[30rem] rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs outline-none focus:border-accent"
            />
            <label className="flex items-center gap-1.5" title="How long to wait per port">
              <span className="text-text-muted">Wait</span>
              <select
                value={timeoutMs}
                onChange={(e) => changeTimeout(Number(e.target.value))}
                className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs outline-none focus:border-accent"
              >
                {TIMEOUTS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            {scanning ? (
              <button
                onClick={stop}
                className="rounded-md bg-surface-2 px-3 py-1 font-medium transition-colors hover:bg-border"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={scan}
                disabled={!host.trim() || parsed.error !== null || busy}
                className="rounded-md border border-border px-2.5 py-1 font-medium transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
              >
                Check ports
              </button>
            )}
            {parsed.error ? (
              <span className="text-warn">{parsed.error}</span>
            ) : (
              <span className="text-text-muted">
                {parsed.ports.length.toLocaleString()} port
                {parsed.ports.length === 1 ? '' : 's'}
                {/* Worth saying before someone starts a full-range scan and
                    assumes it has hung. */}
                {estimate > 20 && <> · up to {formatDuration(estimate)}</>}
              </span>
            )}
            {scanned && scanned.target !== scanned.addr && (
              <span className="font-mono text-text-muted">→ {scanned.addr}</span>
            )}
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="text-text-muted">Presets</span>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => changePorts(p.value)}
                disabled={scanning}
                className={`rounded-md border px-2 py-0.5 transition-colors disabled:opacity-40 ${
                  portsText === p.value
                    ? 'border-accent text-accent'
                    : 'border-border text-text-muted hover:text-text'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {progress && progress.total > 0 && (scanning || progress.done < progress.total) && (
            <div className="mb-3 flex max-w-lg items-center gap-3 text-xs">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full bg-accent transition-[width] duration-200"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
              <span className="shrink-0 font-mono text-text-muted">
                {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
              </span>
            </div>
          )}

          {results.length > 0 && (
            <table className="w-full max-w-lg text-xs">
              <thead>
                <tr className="text-left text-text-muted">
                  <th className="pb-2 font-medium">Port</th>
                  <th className="pb-2 font-medium">State</th>
                  <th className="pb-2 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.port} className="border-t border-border">
                    <td className="py-1.5 font-mono">{r.port}</td>
                    <td className={`py-1.5 ${STATE_COLOR[r.state]}`} title={STATE_HINT[r.state]}>
                      {STATE_LABEL[r.state]}
                    </td>
                    <td className="py-1.5 text-right font-mono text-text-muted">
                      {r.ms === null ? '—' : formatMs(r.ms)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {summary && (
            <p className="mt-3 max-w-lg text-xs text-text-muted">
              {summary.counts.checked.toLocaleString()} checked ·{' '}
              <span className={summary.counts.open > 0 ? 'text-ok' : ''}>
                {summary.counts.open.toLocaleString()} open
              </span>{' '}
              · {summary.counts.refused.toLocaleString()} refused ·{' '}
              {summary.counts.filtered.toLocaleString()} no answer
              {summary.openOnly && (
                // Otherwise a table of three rows after checking 65,000 ports
                // looks like most of the results went missing.
                <>
                  {' '}
                  — only open ports are listed above; there are too many to show
                  individually.
                </>
              )}
              {summary.counts.refused > 0 && summary.counts.open === 0 && (
                <> The host answered, so it is up — nothing was listening.</>
              )}
            </p>
          )}

          {results.length === 0 && !scanning && !summary && (
            <p className="max-w-2xl text-xs text-text-muted">
              Checks whether TCP ports accept connections. <em>Refused</em> means nothing is
              listening but the host answered — which also makes this the way to monitor
              something that blocks ping entirely. Wide ranges are fine; above {DETAIL_LIMIT}{' '}
              ports only the open ones are listed.
            </p>
          )}

          {scanning && results.length === 0 && !progress && (
            <p className="text-xs text-text-muted">Checking…</p>
          )}
        </section>
      </div>
    </div>
  );
}
