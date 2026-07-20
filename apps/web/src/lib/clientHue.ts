/**
 * Per-client identity colour (the content axis — orthogonal to the Rausch accent). A workspace's
 * hue is stable across the whole app: same client, same colour on its cover, dot, and spine.
 *
 * Known clients get hand-picked hues that read well together; anything else is hashed onto the same
 * palette so a 7th, 20th, or 60th client still gets a consistent, distinct-ish colour with no config.
 */
const PALETTE = [
  '#7A5AF8', // violet
  '#08B5D6', // cyan
  '#7BC62D', // leaf
  '#F0A020', // gold
  '#FB6A4A', // coral
  '#EC4899', // pink
  '#0BA96B', // jade
  '#3B82F6', // blue
  '#8B5CF6', // purple
  '#14B8A6', // teal
  '#F59E0B', // amber
  '#EF4444', // red
];

const NAMED: Record<string, string> = {
  antidote: '#7A5AF8',
  mlearn: '#08B5D6',
  'm-learn': '#08B5D6',
  gls: '#F0A020',
  ecolive: '#7BC62D',
  'empower&shine': '#FB6A4A',
  empowerandshine: '#FB6A4A',
  'empower and shine': '#FB6A4A',
  'blossom wellbeing': '#EC4899',
  blossom: '#EC4899',
};

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Resolve a workspace name (or id) to its stable hex hue. */
export function clientHue(nameOrId: string): string {
  const key = nameOrId.trim().toLowerCase();
  return NAMED[key] ?? PALETTE[hash(key) % PALETTE.length]!;
}

/** A soft two-stop gradient for a client "cover", derived from its hue. */
export function clientCover(nameOrId: string): string {
  const base = clientHue(nameOrId);
  return `linear-gradient(135deg, ${base}, ${base}cc)`;
}

/** First grapheme, uppercased — for the cover monogram. */
export function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}
