/**
 * Series colours for the latency chart.
 *
 * Canvas cannot read CSS custom properties, so these are concrete values rather
 * than `var(--…)`. Lightness and chroma are held constant within each theme so
 * no single host visually dominates; only hue varies. Past ten hosts the hues
 * repeat with a dash pattern, which keeps series distinguishable without
 * degenerating into a rainbow, and gives a non-colour cue for anyone who cannot
 * separate the hues.
 */

// Ordered so consecutive hosts land far apart on the hue wheel — adjacent
// entries are ~100° apart or more. Ten categorical colours is the practical
// limit for hue alone, so lightness alternates as a second channel: any two
// neighbours differ in both hue and lightness, which also helps when hue
// discrimination is impaired.
const HUES = [255, 145, 35, 300, 195, 85, 340, 130, 60, 270];

const light = (h: number, i: number) => `oklch(${i % 2 === 0 ? 50 : 63}% 0.15 ${h})`;
const dark = (h: number, i: number) => `oklch(${i % 2 === 0 ? 66 : 79}% 0.15 ${h})`;

const LIGHT = HUES.map(light);
const DARK = HUES.map(dark);

/** Dash patterns applied to successive cycles through the hues. */
const DASHES: (number[] | undefined)[] = [undefined, [6, 3], [2, 3], [9, 3, 2, 3]];

export interface SeriesStyle {
  stroke: string;
  dash?: number[];
}

export function seriesStyle(index: number, theme: string): SeriesStyle {
  const ramp = theme === 'dark' ? DARK : LIGHT;
  const stroke = ramp[index % ramp.length]!;
  const dash = DASHES[Math.floor(index / ramp.length) % DASHES.length];
  return dash ? { stroke, dash } : { stroke };
}

/** The light-theme ramp, for offering colour choices in the host editor. */
export const PALETTE_PREVIEW: string[] = LIGHT;

/** A hue split into two lightnesses, one per traffic direction. */
export interface DirectionalStyle {
  received: string;
  sent: string;
}

/**
 * One hue per interface, with lightness encoding direction: sent is the lighter
 * of the pair, received the darker.
 *
 * This means an interface's two bands are recognisably the same colour family
 * while the direction is readable on its own, without relying on which side of
 * the zero line a band sits.
 *
 * **The lightnesses are relative to the theme, not absolute.** Splitting the
 * range at the midpoint — light half for one direction, dark half for the other
 * — is the obvious approach and fails at both ends: near-white washes out on the
 * light theme's background, and near-black disappears on the dark one. Holding
 * both inside the theme's own usable band keeps the pair distinguishable *and*
 * visible.
 *
 * Inverting the colour rather than its lightness fails differently: inverting
 * the channels of a blue gives orange, so the two directions would no longer
 * read as one interface.
 */
export function directionalStyle(index: number, theme: string): DirectionalStyle {
  const hue = HUES[index % HUES.length]!;
  const isDark = theme === 'dark';
  return {
    received: `oklch(${isDark ? 58 : 46}% 0.15 ${hue})`,
    // Slightly less chroma: at high lightness a saturated hue drifts out of
    // sRGB and gets clamped, which shifts it away from its own darker half.
    sent: `oklch(${isDark ? 84 : 76}% 0.12 ${hue})`,
  };
}

/** Colours for chart chrome, matching the CSS token values per theme. */
export function chartTheme(theme: string) {
  const dark = theme === 'dark';
  return {
    axis: dark ? 'oklch(70% 0.008 265)' : 'oklch(52% 0.008 265)',
    grid: dark ? 'oklch(31% 0.012 265)' : 'oklch(91% 0.004 265)',
    cursor: dark ? 'oklch(70% 0.15 255)' : 'oklch(58% 0.16 255)',
  };
}
