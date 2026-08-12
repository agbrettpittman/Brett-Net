import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREF,
  isThemePref,
  readPref,
  resolveTheme,
  THEME_KEY,
  THEME_PREFS,
} from './theme';

const storage = (value: string | null) => ({ getItem: () => value });

describe('isThemePref', () => {
  it('accepts the three valid preferences', () => {
    for (const p of THEME_PREFS) expect(isThemePref(p)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const v of [null, undefined, '', 'Dark', 'auto', 42, {}]) {
      expect(isThemePref(v)).toBe(false);
    }
  });
});

describe('resolveTheme', () => {
  it('honours an explicit choice regardless of the system', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('follows the system when set to system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('always resolves to a concrete theme', () => {
    for (const p of THEME_PREFS) {
      for (const dark of [true, false]) {
        expect(['light', 'dark']).toContain(resolveTheme(p, dark));
      }
    }
  });
});

describe('readPref', () => {
  it('defaults to system when nothing is stored', () => {
    expect(readPref(storage(null))).toBe(DEFAULT_PREF);
  });

  it('reads a stored preference', () => {
    expect(readPref(storage('dark'))).toBe('dark');
    expect(readPref(storage('system'))).toBe('system');
  });

  it('keeps working with values written before the toggle was three-way', () => {
    // Older builds stored a bare "light"/"dark"; both are still valid.
    expect(readPref(storage('light'))).toBe('light');
  });

  it('falls back to the default on a corrupt value', () => {
    expect(readPref(storage('purple'))).toBe(DEFAULT_PREF);
  });

  it('survives storage throwing', () => {
    const hostile = {
      getItem() {
        throw new Error('storage disabled');
      },
    };
    expect(readPref(hostile)).toBe(DEFAULT_PREF);
  });

  it('uses the agreed storage key', () => {
    expect(THEME_KEY).toBe('theme');
  });
});
