import { useCallback, useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { onKeepAwakeExpired, setKeepAwake } from '../lib/ipc';
import {
  AWAKE_DURATIONS,
  AWAKE_MODES,
  DEFAULT_AWAKE_SEC,
  formatRemaining,
  type AwakeMode,
} from '../lib/keepAwake';

/**
 * Stops the machine sleeping, and optionally stops it locking.
 *
 * Deliberately not persisted: a wake lock that re-armed itself on the next
 * launch would keep a laptop awake in a bag, and nobody would think to blame a
 * network monitor. It lasts until switched off, until the timer runs out, or
 * until the app closes.
 */
export function KeepAwake() {
  const [mode, setMode] = useState<AwakeMode>('off');
  const [seconds, setSeconds] = useState(DEFAULT_AWAKE_SEC);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** Latest request wins, so a slow reply cannot resurrect an old mode. */
  const request = useRef(0);

  const apply = useCallback((next: AwakeMode, forSeconds: number) => {
    const ticket = (request.current += 1);
    setError(null);
    setMode(next);
    setExpiresAt(next === 'off' || forSeconds === 0 ? null : Date.now() + forSeconds * 1000);

    setKeepAwake(next, forSeconds).catch((e: unknown) => {
      if (request.current !== ticket) return;
      setMode('off');
      setExpiresAt(null);
      setError(String(e));
    });
  }, []);

  // The backend owns the deadline and says when it lapses, rather than the UI
  // racing its own timer — a webview in a minimised window can be throttled,
  // and a wake lock outliving its countdown is the one failure that matters.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    onKeepAwakeExpired(() => {
      request.current += 1;
      setMode('off');
      setExpiresAt(null);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (expiresAt === null) {
      setRemaining('');
      return;
    }
    const show = () => setRemaining(formatRemaining(expiresAt - Date.now()));
    show();
    const id = setInterval(show, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  // Release on unmount. The process exiting clears it anyway, but this covers a
  // hot reload during development leaving a lock behind.
  useEffect(() => {
    return () => {
      setKeepAwake('off', 0).catch(() => {});
    };
  }, []);

  const active = mode !== 'off';
  const hint = AWAKE_MODES.find((m) => m.value === mode)?.hint ?? '';

  return (
    <span className="flex items-center gap-1.5 text-xs">
      <select
        value={mode}
        onChange={(e) => apply(e.target.value as AwakeMode, seconds)}
        title={error ?? hint}
        aria-label="Keep this PC awake"
        className={`rounded-md border bg-surface px-1.5 py-0.5 outline-none focus:border-accent ${
          error ? 'border-danger/60 text-danger' : active ? 'border-accent text-accent' : 'border-border text-text-muted'
        }`}
      >
        {AWAKE_MODES.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>

      {active && (
        <select
          value={seconds}
          onChange={(e) => {
            // Changing the limit restarts it, which is the only reading of
            // "4 hours" that is not a lie about when it will stop.
            const next = Number(e.target.value);
            setSeconds(next);
            apply(mode, next);
          }}
          title="How long before this releases itself"
          aria-label="Keep awake for"
          className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-text-muted outline-none focus:border-accent"
        >
          {AWAKE_DURATIONS.map((d) => (
            <option key={d.sec} value={d.sec}>
              {d.label}
            </option>
          ))}
        </select>
      )}

      {active && remaining && (
        <span className="font-mono text-text-muted" title="Time left before it releases itself">
          {remaining}
        </span>
      )}
    </span>
  );
}
