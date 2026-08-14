import { useCallback, useEffect, useState } from 'react';
import { hostInfo, type HostInfo } from './lib/ipc';
import {
  applyTheme,
  readPref,
  resolveTheme,
  systemPrefersDark,
  THEME_KEY,
  type ThemePref,
} from './lib/theme';
import { KeepAwake } from './components/KeepAwake';
import { ThemeToggle } from './components/ThemeToggle';
import { UpdateBanner } from './components/UpdateBanner';
import { PingView } from './features/ping/PingView';
import { PathView } from './features/path/PathView';
import { DnsView } from './features/dns/DnsView';
import { ConnectionsView } from './features/connections/ConnectionsView';
import { AdaptersView } from './features/adapters/AdaptersView';

const TABS = [
  { id: 'ping', label: 'Ping' },
  { id: 'path', label: 'Path' },
  { id: 'dns', label: 'DNS & Ports' },
  { id: 'connections', label: 'Connections' },
  { id: 'adapters', label: 'Adapters' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/**
 * App shell: title, tool tabs, theme, and the update banner.
 *
 * Every tool stays mounted and is hidden with CSS rather than unmounted.
 * Unmounting the ping view would drop its sample store and restart the
 * monitor, so switching tabs would quietly reset the graph.
 */
export default function App() {
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [tab, setTab] = useState<TabId>('ping');
  const [themePref, setThemePref] = useState<ThemePref>(() => readPref(localStorage));
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const theme = resolveTheme(themePref, systemDark);

  useEffect(() => {
    hostInfo().then(setInfo).catch(() => {});
  }, []);

  // Track the OS setting so "system" updates live rather than only on restart.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const changeTheme = useCallback((pref: ThemePref) => {
    localStorage.setItem(THEME_KEY, pref);
    setThemePref(pref);
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-2.5">
        <div className="flex items-center gap-5">
          <span className="text-[15px] font-semibold tracking-tight">Brett-Net</span>
          <nav className="flex items-center gap-1" role="tablist" aria-label="Tools">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  tab === t.id
                    ? 'bg-surface-2 text-text'
                    : 'text-text-muted hover:bg-surface-2 hover:text-text'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-muted">{info ? `v${info.appVersion}` : ''}</span>
          <KeepAwake />
          <ThemeToggle value={themePref} onChange={changeTheme} />
        </div>
      </header>

      <UpdateBanner />

      <main className="min-h-0 flex-1">
        <div className={tab === 'ping' ? 'h-full' : 'hidden'}>
          <PingView theme={theme} />
        </div>
        <div className={tab === 'path' ? 'h-full' : 'hidden'}>
          <PathView />
        </div>
        <div className={tab === 'dns' ? 'h-full' : 'hidden'}>
          <DnsView />
        </div>
        <div className={tab === 'connections' ? 'h-full' : 'hidden'}>
          <ConnectionsView active={tab === 'connections'} />
        </div>
        <div className={tab === 'adapters' ? 'h-full' : 'hidden'}>
          <AdaptersView theme={theme} />
        </div>
      </main>
    </div>
  );
}
