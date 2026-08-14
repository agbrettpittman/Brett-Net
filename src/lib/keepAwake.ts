/** Mirrors `awake::Mode`. */
export type AwakeMode = 'off' | 'awake' | 'active';

export const AWAKE_MODES: { value: AwakeMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Normal power behaviour.' },
  {
    value: 'awake',
    label: 'Keep awake',
    hint: 'Stops the PC sleeping. The screen can still switch off and the session can still lock.',
  },
  {
    value: 'active',
    label: 'Keep active',
    hint: 'Stops the PC sleeping and keeps the session from going idle, so it does not lock. Sends one harmless keystroke, and only after a minute with no input of your own.',
  },
];

/**
 * How long a request runs before releasing itself.
 *
 * A limit is the default rather than an option, because the failure mode of
 * forgetting is a machine that never sleeps again. `0` means no limit, and is
 * last so it has to be chosen deliberately.
 */
export const AWAKE_DURATIONS: { sec: number; label: string }[] = [
  { sec: 5 * 60, label: '5 minutes' },
  { sec: 15 * 60, label: '15 minutes' },
  { sec: 30 * 60, label: '30 minutes' },
  { sec: 60 * 60, label: '1 hour' },
  { sec: 2 * 60 * 60, label: '2 hours' },
  { sec: 4 * 60 * 60, label: '4 hours' },
  { sec: 8 * 60 * 60, label: '8 hours' },
  { sec: 0, label: 'No limit' },
];

export const DEFAULT_AWAKE_SEC = 5 * 60;

/**
 * Countdown text, `m:ss` under an hour and `h:mm:ss` over it.
 *
 * Clamped at zero: the interval that drives it can fire a tick after the
 * deadline has passed but before the backend's "expired" event has arrived, and
 * a flash of `-0:01` reads as a bug.
 */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);

  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
