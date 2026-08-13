import { useCallback, useEffect, useState } from 'react';
import { listAdapters, type Adapter } from '../../lib/ipc';
import { formatSpeed, sortAdapters, sortAddresses } from '../../lib/adapters';
import { readBoolean, write } from '../../lib/prefs';

const SHOW_ALL_KEY = 'adapters.showAll';

/**
 * The machine's own network configuration.
 *
 * Inactive adapters are hidden by default: a typical Windows box carries a
 * dozen tunnel and virtual interfaces that are all down, and burying the one
 * carrying traffic among them defeats the point.
 */
export function AdaptersView() {
  const [adapters, setAdapters] = useState<Adapter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(() =>
    readBoolean(localStorage, SHOW_ALL_KEY, false),
  );

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

  const toggleShowAll = useCallback((on: boolean) => {
    write(localStorage, SHOW_ALL_KEY, on);
    setShowAll(on);
  }, []);

  const all = adapters ?? [];
  const visible = showAll ? all : all.filter((a) => a.active);
  const hidden = all.length - visible.length;

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

        <span className="ml-auto text-text-muted">
          {visible.length} of {all.length} interface{all.length === 1 ? '' : 's'}
        </span>
      </div>

      {error && (
        <p className="mx-5 mt-3 shrink-0 rounded-md border border-danger/40 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </p>
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
            <AdapterCard key={`${a.name}-${a.description}`} adapter={a} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AdapterCard({ adapter: a }: { adapter: Adapter }) {
  return (
    <section
      className={`max-w-3xl rounded-[var(--radius)] border border-border bg-surface p-4 ${
        a.active ? '' : 'opacity-60'
      }`}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
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
