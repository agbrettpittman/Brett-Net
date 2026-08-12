/** What the user picked. "system" follows the OS setting. */
export type ThemePref = 'light' | 'dark' | 'system';

/** What actually gets rendered. */
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'theme';
export const DEFAULT_PREF: ThemePref = 'system';

export const THEME_PREFS: ThemePref[] = ['light', 'system', 'dark'];

export function isThemePref(value: unknown): value is ThemePref {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function resolveTheme(pref: ThemePref, systemPrefersDark: boolean): Theme {
  if (pref === 'system') return systemPrefersDark ? 'dark' : 'light';
  return pref;
}

/**
 * Reads the stored preference, tolerating anything unexpected.
 *
 * Values written before this was three-way were plain "light"/"dark", which are
 * still valid preferences, so no migration is needed.
 */
export function readPref(storage: Pick<Storage, 'getItem'>): ThemePref {
  let raw: string | null = null;
  try {
    raw = storage.getItem(THEME_KEY);
  } catch {
    // Storage can throw when disabled; fall through to the default.
  }
  return isThemePref(raw) ? raw : DEFAULT_PREF;
}

export function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  );
}

/** Applies a resolved theme to the document. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export const THEME_LABEL: Record<ThemePref, string> = {
  light: 'Light',
  system: 'Match system',
  dark: 'Dark',
};
