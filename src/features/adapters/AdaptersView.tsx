import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { interfaceCounters, listAdapters, type Adapter } from '../../lib/ipc';
import { formatSpeed, sortAdapters, sortAddresses } from '../../lib/adapters';
import {
  accumulate,
  formatBytes,
  formatRate,
  throughput,
  type CounterSample,
  type Throughput,
  type Totals,
} from '../../lib/traffic';
import { SeriesStore } from '../../lib/series';
import { directionalStyle, type DirectionalStyle } from '../../lib/palette';
import type { Theme } from '../../lib/theme';
import { readBoolean, write } from '../../lib/prefs';
import { DirectionSwatch, ThroughputChart, type ChartInterface } from './ThroughputChart';

const SHOW_ALL_KEY = 'adapters.showAll';
const AGGREGATE_KEY = 'adapters.aggregate';

/** How often the byte counters are read. Matches the ping tick. */
const POLL_MS = 1000;
/** Samples kept for the chart — ten minutes at one per second. */
const HISTORY = 600;

const inKey = (luid: string) => `${luid}:in`;
const outKey = (luid: string) => `${luid}:out`;

/**
 * The machine's own network configuration, and what is flowing through it.
 *
 * Inactive adapters are hidden by default: a typical Windows box carries a
 * dozen tunnel and virtual interfaces that are all down, and burying the one
 * carrying traffic among them defeats the point.
 *
 * **Counters are polled even while another tab is showing.** The session totals
 * are the whole point of the feature, and only counting the seconds you happened
 * to be looking at this tab would make them meaningless.
 */
export function AdaptersView({ theme }: { theme: Theme }) {
  const [adapters, setAdapters] = useState<Adapter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(() =>
    readBoolean(localStorage, SHOW_ALL_KEY, false),
  );
  const [aggregate, setAggregate] = useState(() =>
    readBoolean(localStorage, AGGREGATE_KEY, false),
  );

  const [rates, setRates] = useState<Map<string, Throughput>>(new Map());
  const [totals, setTotals] = useState<Totals>(new Map());
  const [chosen, setChosen] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const store = useRef(new SeriesStore(HISTORY));

  const refresh = useCallback(() => {
    setLoading(true);
    listAdapters()
      .then((a) => {
        setAdapters(sortAdapters(a));
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    let cancelled = false;
    let previous: CounterSample | null = null;

    const read = async () => {
      let next: CounterSample;
      try {
        next = await interfaceCounters();
      } catch {
        // A failed read is not worth an error banner over live configuration;
        // the next one is a second away.
        return;
      }
      if (cancelled) return;

      const was = previous;
      previous = next;

      const measured = throughput(was, next);
      setTotals((t) => accumulate(t, was, next));

      // Only record a column when there is something real to record. Pushing an
      // all-null one after a suspend would draw a gap that reads as an outage.
      if (measured.length > 0) {
        const column = new Map<string, number | null>();
        for (const m of measured) {
          column.set(inKey(m.luid), m.inBps);
          column.set(outKey(m.luid), m.outBps);
        }
        store.current.push(next.t / 1000, column);
        setRates(new Map(measured.map((m) => [m.luid, m])));
        setRevision((n) => n + 1);
      }
    };

    void read();
    const id = setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const toggleShowAll = useCallback((on: boolean) => {
    write(localStorage, SHOW_ALL_KEY, on);
    setShowAll(on);
  }, []);

  const all = useMemo(() => adapters ?? [], [adapters]);
  const visible = useMemo(
    () => (showAll ? all : all.filter((a) => a.active)),
    [all, showAll],
  );
  const hidden = all.length - visible.length;

  // Falls back to the first visible adapter, which `sortAdapters` has already
  // made the one carrying traffic. A selection hidden by the filter would
  // otherwise leave the chart pointed at nothing.
  const selected = useMemo(
    () => visible.find((a) => a.luid === chosen) ?? visible[0] ?? null,
    [visible, chosen],
  );

  /** Colour pair per visible interface, so a card and its bands always agree. */
  const colors = useMemo(() => {
    const map = new Map<string, DirectionalStyle>();
    visible.forEach((a, i) => map.set(a.luid, directionalStyle(i, theme)));
    return map;
  }, [visible, theme]);

  const charted: ChartInterface[] = useMemo(() => {
    const pick = aggregate ? visible : selected ? [selected] : [];
    return pick.map((a) => ({
      luid: a.luid,
      name: a.name,
      ...(colors.get(a.luid) ?? { received: '#888888', sent: '#cccccc' }),
    }));
  }, [aggregate, visible, selected, colors]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-2.5 text-xs">
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded-md bg-accent px-3 py-1 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {loading ? 'Reading…' : 'Refresh'}
        </button>

        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => toggleShowAll(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          <span className="text-text-muted">
            Show inactive{hidden > 0 && !showAll ? ` (${hidden})` : ''}
          </span>
        </label>

        <label className="flex items-center gap-1.5" title="Stack every visible interface in one chart">
          <input
            type="checkbox"
            checked={aggregate}
            onChange={(e) => {
              write(localStorage, AGGREGATE_KEY, e.target.checked);
              setAggregate(e.target.checked);
            }}
            className="accent-[var(--accent)]"
          />
          <span className="text-text-muted">Stack all</span>
        </label>

        <span className="ml-auto text-text-muted">
          {visible.length} of {all.length} interface{all.length === 1 ? '' : 's'}
        </span>
      </div>

      {error && (
        <p className="mx-5 mt-3 shrink-0 rounded-md border border-danger/40 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </p>
      )}

      {charted.length > 0 && (
        <section className="h-56 shrink-0 border-b border-border px-2 py-2">
          <ThroughputChart
            store={store.current}
            interfaces={charted}
            inKey={inKey}
            outKey={outKey}
            theme={theme}
            revision={revision}
          />
        </section>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
        {visible.length === 0 && !loading && !error && (
          <p className="pt-10 text-center text-xs text-text-muted">
            {all.length === 0
              ? 'No interfaces found.'
              : 'No active interfaces — tick "Show inactive" to see the rest.'}
          </p>
        )}

        <div className="space-y-3">
          {visible.map((a) => (
            <AdapterCard
              key={a.luid}
              adapter={a}
              rate={rates.get(a.luid)}
              total={totals.get(a.luid)}
              color={colors.get(a.luid) ?? { received: '#888888', sent: '#cccccc' }}
              // With everything stacked, no single card is "the charted one".
              selected={!aggregate && selected?.luid === a.luid}
              onSelect={() => setChosen(a.luid)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface CardProps {
  adapter: Adapter;
  rate: Throughput | undefined;
  total: { inBytes: number; outBytes: number } | undefined;
  /** Matches this interface's bands in the chart. */
  color: DirectionalStyle;
  selected: boolean;
  onSelect: () => void;
}

function AdapterCard({ adapter: a, rate, total, color, selected, onSelect }: CardProps) {
  return (
    <section
      onClick={onSelect}
      className={`max-w-3xl cursor-pointer rounded-[var(--radius)] border bg-surface p-4 transition-colors ${
        selected ? 'border-accent' : 'border-border hover:border-text-muted'
      } ${a.active ? '' : 'opacity-60'}`}
      title={selected ? 'Charted above' : 'Click to chart this interface'}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* The chart's colours, so a band traces back to its interface. */}
        <DirectionSwatch received={color.received} sent={color.sent} />
        <span
          className={`inline-block size-2 shrink-0 rounded-full ${
            a.active ? 'bg-ok' : a.status === 'Up' ? 'bg-warn' : 'bg-border'
          }`}
          title={a.active ? 'Up and configured' : a.status}
        />
        <h2 className="text-xs font-medium">{a.name}</h2>
        <span className="text-xs text-text-muted">
          {a.kind} · {a.status}
          {a.speedBps !== null && <> · {formatSpeed(a.speedBps)}</>}
        </span>
      </header>

      <p className="mt-1 pl-5 text-xs text-text-muted" data-selectable>
        {a.description}
      </p>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 pl-5 text-xs">
        <span className="font-mono">↓ {formatRate(rate?.inBps ?? 0)}</span>
        <span className="font-mono">↑ {formatRate(rate?.outBps ?? 0)}</span>
        <span className="text-text-muted">
          this session{' '}
          <span className="font-mono">{formatBytes(total?.inBytes ?? 0)}</span> in ·{' '}
          <span className="font-mono">{formatBytes(total?.outBytes ?? 0)}</span> out
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pl-5 text-xs">
        <Field label="Address" values={sortAddresses(a.addresses)} />
        <Field label="Gateway" values={a.gateways} />
        <Field label="DNS" values={a.dns} />
        {a.dhcpServer && <Field label="DHCP" values={[a.dhcpServer]} />}
        <Field
          label="Hardware"
          values={[
            [a.mac, a.mtu === null ? null : `MTU ${a.mtu}`].filter(Boolean).join(' · '),
          ]}
          mono={false}
        />
      </dl>
    </section>
  );
}

function Field({
  label,
  values,
  mono = true,
}: {
  label: string;
  values: string[];
  mono?: boolean;
}) {
  // An interface with no gateway is normal, not missing data — say so rather
  // than leaving a blank that reads as a failure to load.
  const shown = values.filter((v) => v !== '');

  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className={mono ? 'font-mono' : ''} data-selectable>
        {shown.length === 0 ? (
          <span className="text-text-muted">none</span>
        ) : (
          shown.map((v) => <div key={v}>{v}</div>)
        )}
      </dd>
    </>
  );
}
