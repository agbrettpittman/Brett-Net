import type { ReactElement } from 'react';
import { THEME_LABEL, THEME_PREFS, type ThemePref } from '../lib/theme';

// React 19 dropped the global JSX namespace; ReactElement is the replacement.
const ICONS: Record<ThemePref, ReactElement> = {
  light: (
    <>
      <circle cx="8" cy="8" r="3.2" />
      <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1" />
    </>
  ),
  system: (
    <>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.2" />
      <path d="M5.5 14h5M8 11.5V14" />
    </>
  ),
  dark: <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z" />,
};

/**
 * Light / system / dark, as a segmented control rather than a cycling button —
 * with three states a single button gives no indication of what comes next.
 */
export function ThemeToggle({
  value,
  onChange,
}: {
  value: ThemePref;
  onChange: (pref: ThemePref) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {THEME_PREFS.map((pref) => {
        const active = pref === value;
        return (
          <button
            key={pref}
            role="radio"
            aria-checked={active}
            aria-label={THEME_LABEL[pref]}
            title={THEME_LABEL[pref]}
            onClick={() => onChange(pref)}
            className={`rounded p-1 transition-colors ${
              active
                ? 'bg-surface-2 text-text'
                : 'text-text-muted hover:bg-surface-2 hover:text-text'
            }`}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {ICONS[pref]}
            </svg>
          </button>
        );
      })}
    </div>
  );
}
