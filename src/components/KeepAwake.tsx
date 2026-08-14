import { useCallback, useEffect, useState } from 'react';
import { setKeepAwake } from '../lib/ipc';

/**
 * Stops the machine sleeping while something long-running is in flight.
 *
 * Deliberately not persisted: a wake lock that re-armed itself on the next
 * launch would keep a laptop awake in a bag, and nobody would think to blame a
 * network monitor. It lasts until it is switched off or the app is closed, and
 * the button says so.
 */
export function KeepAwake() {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(() => {
    const next = !on;
    // Optimistic, then corrected on failure: the round trip is a channel send
    // and a Win32 call, so waiting for it would only make the button feel slow.
    setOn(next);
    setError(null);
    setKeepAwake(next).catch((e: unknown) => {
      setOn(!next);
      setError(String(e));
    });
  }, [on]);

  // Release explicitly on unmount. The process exiting clears it anyway, but
  // this covers a reload during development leaving a lock behind.
  useEffect(() => {
    return () => {
      setKeepAwake(false).catch(() => {});
    };
  }, []);

  return (
    <button
      onClick={toggle}
      aria-pressed={on}
      title={
        error ??
        (on
          ? 'Keeping this PC awake. Click to stop — it also stops when you close Brett-Net.'
          : 'Stop this PC sleeping. The screen can still turn off; only sleep is blocked.')
      }
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
        error
          ? 'border-danger/50 text-danger'
          : on
            ? 'border-accent text-accent'
            : 'border-border text-text-muted hover:bg-surface-2 hover:text-text'
      }`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {/* An open eye when held, a closed one when not. */}
        {on ? (
          <>
            <path d="M1 8s2.6-4.2 7-4.2S15 8 15 8s-2.6 4.2-7 4.2S1 8 1 8Z" />
            <circle cx="8" cy="8" r="1.8" />
          </>
        ) : (
          <>
            <path d="M1.6 6.2S3.9 10.4 8 10.4s6.4-4.2 6.4-4.2" />
            <path d="M3.4 8.9 2 10.7M8 10.4v2M12.6 8.9 14 10.7" />
          </>
        )}
      </svg>
      {on ? 'Awake' : 'Keep awake'}
    </button>
  );
}
