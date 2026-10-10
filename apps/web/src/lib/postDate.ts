/**
 * Posts published "now" were once stored with the Unix epoch as `publishAt`, and a pending fix
 * stores `null` instead. Both mean "no date": anything before 2001 (and anything unparseable) is
 * treated as missing rather than rendered as 01/01/1970.
 */
const FIRST_REAL_DATE = Date.UTC(2001, 0, 1);

/** The API client returns JSON as-is, so dates arrive as ISO strings despite the contract's Date type. */
type PublishAt = Date | string | number | null | undefined;

/** The real date, or null when the value is missing, unparseable, or a pre-2001 placeholder. */
export function parsePublishAt(value: PublishAt): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) || time < FIRST_REAL_DATE ? null : date;
}

export function hasPublishDate(value: PublishAt): boolean {
  return parsePublishAt(value) !== null;
}

/** Date + time for lists and cards; "—" when the post has no real date. */
export function formatPublishAt(value: PublishAt): string {
  return parsePublishAt(value)?.toLocaleString() ?? '—';
}

/** Time of day only, for calendar chips; "—" when the post has no real date. */
export function formatPublishTime(value: PublishAt): string {
  return (
    parsePublishAt(value)?.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) ??
    '—'
  );
}
