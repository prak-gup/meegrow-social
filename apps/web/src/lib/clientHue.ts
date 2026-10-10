/**
 * Per-client identity colour (the content axis — orthogonal to the Rausch accent). A workspace's
 * hue is stable across the whole app: same client, same colour on its cover, dot, and spine.
 *
 * Known clients get hand-picked hues that read well together; anything else is hashed onto the same
 * --hue-N token palette (index.css) so a 7th, 20th, or 60th client still gets a consistent, distinct-ish colour with no config.
 */
/** Number of --hue-N tokens defined in index.css. */
const HUES = 12;

const NAMED: Record<string, number> = {
  antidote: 1,
  mlearn: 2,
  'm-learn': 2,
  gls: 4,
  ecolive: 3,
  'empower&shine': 5,
  empowerandshine: 5,
  'empower and shine': 5,
  'blossom wellbeing': 6,
  blossom: 6,
};

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function hueVar(nameOrId: string): string {
  const key = nameOrId.trim().toLowerCase();
  return `var(--hue-${NAMED[key] ?? (hash(key) % HUES) + 1})`;
}

/** Resolve a workspace name (or id) to its stable hue, as a CSS colour from the token palette. */
export function clientHue(nameOrId: string): string {
  return `hsl(${hueVar(nameOrId)})`;
}

/** The "all clients" conic swatch: every hue token in order. */
export const ALL_CLIENTS_SWATCH = `conic-gradient(${Array.from(
  { length: HUES + 1 },
  (_, i) => `hsl(var(--hue-${(i % HUES) + 1}))`,
).join(',')})`;

/** A soft two-stop gradient for a client "cover", derived from its hue. */
export function clientCover(nameOrId: string): string {
  const v = hueVar(nameOrId);
  return `linear-gradient(135deg, hsl(${v}), hsl(${v} / 0.8))`;
}

/** First grapheme, uppercased — for the cover monogram. */
export function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}
