import { useEffect, useState } from 'react';
import type { Update } from '@tauri-apps/plugin-updater';
import { findUpdate, summarise } from '../lib/update';

type Phase = 'installing' | 'done' | 'error';

/**
 * Offers an update when one exists, and is invisible otherwise.
 *
 * The check is deliberately silent about failure — see `findUpdate` — so until
 * a release publishes a `latest.json` this component renders nothing at all.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [message, setMessage] = useState('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void findUpdate().then((u) => {
      if (!cancelled) setUpdate(u);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update || dismissed) return null;

  const install = () => {
    setPhase('installing');
    update
      .downloadAndInstall()
      .then(() => {
        // The Windows installer closes the app to replace it, so there is
        // nothing to relaunch from here — restarting is the user's move.
        setPhase('done');
        setMessage('Update installed. Restart Brett-Net to finish.');
      })
      .catch((e: unknown) => {
        setPhase('error');
        setMessage(String(e));
      });
  };

  const notes = summarise(update.body);

  return (
    <div className="mx-5 mt-3 flex shrink-0 items-center gap-3 rounded-md border border-accent/40 bg-surface-2 px-3 py-2 text-xs">
      <span className="min-w-0 flex-1">
        {phase === 'done' || phase === 'error' ? (
          <span className={phase === 'error' ? 'text-danger' : ''}>{message}</span>
        ) : (
          <>
            <span className="font-medium">Version {update.version} is available.</span>
            {notes && <span className="ml-2 text-text-muted">{notes}</span>}
          </>
        )}
      </span>

      {phase === null && (
        <button
          onClick={install}
          className="shrink-0 rounded-md bg-accent px-2.5 py-1 font-medium text-white transition-opacity hover:opacity-90"
        >
          Install
        </button>
      )}
      {phase === 'installing' && <span className="shrink-0 text-text-muted">Installing…</span>}

      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 text-text-muted transition-colors hover:text-text"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
