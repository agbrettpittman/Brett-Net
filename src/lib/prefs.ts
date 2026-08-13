/**
 * Small, tool-local preferences backed by `localStorage`.
 *
 * Deliberately not `settings.json`: that file is loaded and saved as a whole by
 * the ping view, so a second component writing its own subset would clobber the
 * first one's keys on every autosave. These values are small, non-critical, and
 * do not need to survive a reinstall.
 */

/** Reads a number, falling back if it is missing or unparseable. */
export function readNumber(
  storage: Pick<Storage, 'getItem'>,
  key: string,
  fallback: number,
): number {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    // Storage can be disabled entirely; the default is always usable.
    return fallback;
  }
}

export function readBoolean(
  storage: Pick<Storage, 'getItem'>,
  key: string,
  fallback: boolean,
): boolean {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    return raw === 'true';
  } catch {
    return fallback;
  }
}

export function write(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  value: string | number | boolean,
): void {
  try {
    storage.setItem(key, String(value));
  } catch {
    // Not being able to remember a preference is not worth surfacing.
  }
}
