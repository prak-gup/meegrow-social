/**
 * Plain caption → the text a platform is actually sent, and how long that platform says it is.
 *
 * Captions in this app are plain text. Bluesky, Telegram, Discord and Slack each read some of that
 * text as markup — a link has to be declared, or `*this*` turns bold, or `<@123>` pings someone —
 * so every one of them needs a conversion, and each counts length in its own unit. Both live here,
 * free of imports and on their own subpath (`@meegrow-social/contracts/platform-text`, for
 * `group-status.ts`'s reason), so the ONE implementation is what the provider sends and what the
 * Composer counts and previews: the counter cannot disagree with the limit that is enforced.
 *
 * Sources for every limit and escaping rule: docs/dev/research/quick-platforms.md.
 */

// --- Measuring --------------------------------------------------------------------------------

/** Minimal shape of `Intl.Segmenter`, which the ES2022 lib this package compiles against lacks. */
interface GraphemeSegmenter {
  segment(text: string): Iterable<unknown>;
}

let segmenter: GraphemeSegmenter | null | undefined;

function graphemeSegmenter(): GraphemeSegmenter | null {
  if (segmenter === undefined) {
    const Segmenter = (
      Intl as unknown as {
        Segmenter?: new (locale?: string, options?: { granularity: string }) => GraphemeSegmenter;
      }
    ).Segmenter;
    segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  return segmenter;
}

/**
 * User-perceived characters (extended grapheme clusters): "👨‍👩‍👧" is one, "हिं" is one. What Bluesky's
 * 300 limit counts. Falls back to code points where `Intl.Segmenter` is missing, which can only
 * over-count — so a post is never let through that the platform would refuse for length.
 */
export function graphemeLength(text: string): number {
  const seg = graphemeSegmenter();
  if (!seg) return [...text].length;
  let count = 0;
  for (const _ of seg.segment(text)) count += 1;
  return count;
}

/** Bytes of the text encoded as UTF-8 — what AT Protocol facet offsets and `maxLength` count. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// --- Finding links, hashtags and mentions -------------------------------------------------------

/** A stretch of the text, as UTF-16 indices (`text.slice(start, end)`). */
export interface TextSpan {
  start: number;
  end: number;
}

export interface UrlSpan extends TextSpan {
  /** The address exactly as typed. */
  url: string;
}

/**
 * Only ASCII URL characters continue an address, so text in a script without spaces around its
 * punctuation ends one where a reader would: in "देखें https://example.com।" the danda is not part
 * of the link.
 */
const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'*]$/;

/** Trailing punctuation belongs to the sentence, not the address; so does an unbalanced bracket. */
function trimUrl(candidate: string): string {
  let url = candidate;
  for (;;) {
    if (TRAILING_PUNCTUATION.test(url)) {
      url = url.slice(0, -1);
      continue;
    }
    const last = url.at(-1);
    const open = last === ')' ? '(' : last === ']' ? '[' : null;
    if (open && url.split(open).length <= url.split(last!).length - 1) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/**
 * The http(s) addresses in a caption, in order. Deliberately narrow: an explicit scheme and a host
 * with a dot. A bare `example.com` is left as text — guessing which words are domains would turn
 * "see you at 5.pm" into a link.
 */
export function findUrls(text: string): UrlSpan[] {
  const spans: UrlSpan[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) continue;
    spans.push({ start: match.index, end: match.index + url.length, url });
  }
  return spans;
}

/** `convert` applied to everything that is not an address; `link` to each address. */
function mapAroundUrls(
  text: string,
  convert: (plain: string, atLineStart: boolean) => string,
  link: (url: string) => string,
): string {
  let out = '';
  let cursor = 0;
  for (const span of findUrls(text)) {
    out += convert(text.slice(cursor, span.start), cursor === 0);
    out += link(span.url);
    cursor = span.end;
  }
  return out + convert(text.slice(cursor), cursor === 0);
}

// --- Bluesky ------------------------------------------------------------------------------------

/** `app.bsky.feed.post` `text`: 300 graphemes AND 3000 UTF-8 bytes (the lexicon states both). */
export const BLUESKY_MAX_GRAPHEMES = 300;
export const BLUESKY_MAX_BYTES = 3000;
/** `app.bsky.richtext.facet#tag`: at most 64 graphemes. */
const BLUESKY_TAG_MAX_GRAPHEMES = 64;

export type BlueskyFacetFeature =
  | { $type: 'app.bsky.richtext.facet#link'; uri: string }
  | { $type: 'app.bsky.richtext.facet#tag'; tag: string }
  | { $type: 'app.bsky.richtext.facet#mention'; did: string };

/** `app.bsky.richtext.facet`. Offsets count BYTES of the UTF-8 text; end is exclusive. */
export interface BlueskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: BlueskyFacetFeature[];
}

/** A UTF-16 span of `text` as the byte range a facet needs. */
export function byteRange(text: string, span: TextSpan): { byteStart: number; byteEnd: number } {
  const byteStart = utf8Length(text.slice(0, span.start));
  return { byteStart, byteEnd: byteStart + utf8Length(text.slice(span.start, span.end)) };
}

export interface TagSpan extends TextSpan {
  /** Without the `#`. */
  tag: string;
}

/**
 * `#tags` in a caption: a `#` at the start or after whitespace, up to the next whitespace, with
 * trailing punctuation dropped. A run of digits alone (`#1`) is not a tag, as in Bluesky's own app.
 */
export function findHashtags(text: string): TagSpan[] {
  const spans: TagSpan[] = [];
  for (const match of text.matchAll(/(^|\s)#([^\s#]+)/gu)) {
    const tag = match[2]!.replace(/[\p{P}\p{S}]+$/u, '');
    if (tag === '' || /^\d+$/.test(tag) || graphemeLength(tag) > BLUESKY_TAG_MAX_GRAPHEMES) {
      continue;
    }
    const start = match.index + match[1]!.length;
    spans.push({ start, end: start + 1 + tag.length, tag });
  }
  return spans;
}

export interface MentionSpan extends TextSpan {
  /** Without the `@`, lower-cased: a handle is a DNS name. */
  handle: string;
}

/** A handle per the AT Protocol handle syntax: DNS labels, the last one not starting with a digit. */
const MENTION_PATTERN =
  /(^|[\s(])@((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)/g;

/** `@handle.example` in a caption. Whether the handle is a real account is the caller's to check. */
export function findMentions(text: string): MentionSpan[] {
  const spans: MentionSpan[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const start = match.index + match[1]!.length;
    const handle = match[2]!;
    spans.push({ start, end: start + 1 + handle.length, handle: handle.toLowerCase() });
  }
  return spans;
}

/**
 * The facets a caption needs on Bluesky. The API links NOTHING by itself: without a facet an
 * address is dead text. `mentionDids` maps a handle to the DID it resolved to; a handle with no
 * entry stays plain text, as the Bluesky guide prescribes for one that does not resolve.
 */
export function blueskyFacets(
  text: string,
  mentionDids: ReadonlyMap<string, string> = new Map(),
): BlueskyFacet[] {
  const urls = findUrls(text);
  const insideUrl = (span: TextSpan): boolean =>
    urls.some((u) => span.start < u.end && span.end > u.start);
  const found: Array<{ span: TextSpan; feature: BlueskyFacetFeature }> = urls.map((span) => ({
    span,
    feature: { $type: 'app.bsky.richtext.facet#link', uri: span.url },
  }));
  for (const span of findHashtags(text)) {
    if (insideUrl(span)) continue;
    found.push({ span, feature: { $type: 'app.bsky.richtext.facet#tag', tag: span.tag } });
  }
  for (const span of findMentions(text)) {
    const did = mentionDids.get(span.handle);
    if (!did || insideUrl(span)) continue;
    found.push({ span, feature: { $type: 'app.bsky.richtext.facet#mention', did } });
  }
  return found
    .sort((a, b) => a.span.start - b.span.start)
    .map(({ span, feature }) => ({ index: byteRange(text, span), features: [feature] }));
}

// --- Telegram -----------------------------------------------------------------------------------

/** `sendMessage` text: 1-4096 characters after entities parsing. */
export const TELEGRAM_MAX_TEXT = 4096;
/** A photo/video caption (and a media group's): 0-1024 characters after entities parsing. */
export const TELEGRAM_MAX_CAPTION = 1024;

/**
 * Caption → Telegram `parse_mode: "HTML"`. Of the three modes this is the one whose escaping rule
 * is three characters long and has no exceptions: every `<`, `>` and `&` that is not markup must
 * be an entity. Nothing else in the text means anything, so nothing else can turn into formatting.
 * Addresses, @usernames and #hashtags are linked by Telegram itself, as for anything a person types.
 */
export function telegramHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

// --- Discord ------------------------------------------------------------------------------------

/** Webhook `content`: up to 2000 characters. */
export const DISCORD_MAX_CONTENT = 2000;

/**
 * Caption → Discord message content with its Markdown defused. Discord renders `content` as
 * Markdown and has no "plain" switch, so the characters that mean something are backslash-escaped:
 * emphasis, strike, code, spoiler, masked links, and `<` — which also takes `<@id>`, `<#id>`,
 * `<@&id>`, `<:emoji:id>` and `<t:…>` with it — plus the ones that only mean something at the
 * start of a line (headings, quotes, lists, small text).
 *
 * Addresses are passed through untouched: a backslash inside one would break the link Discord
 * makes of it. `@everyone` and `@here` are plain words here; what stops them pinging is the
 * `allowed_mentions` the provider sends, not this.
 */
export function discordContent(text: string): string {
  const escapePlain = (plain: string, atStart: boolean): string => {
    const escaped = plain.replace(/[\\*_~`|<[]/g, '\\$&');
    return escaped.replace(/(^|\n)([ \t]*)([#>-])/g, (whole, lead: string, indent: string, c) =>
      lead === '' && !atStart ? whole : `${lead}${indent}\\${c}`,
    );
  };
  return mapAroundUrls(text, escapePlain, (url) => url);
}

// --- Slack --------------------------------------------------------------------------------------

/** A section block's text: 1-3000 characters. */
export const SLACK_MAX_SECTION_TEXT = 3000;

const slackEscape = (text: string): string =>
  text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

/**
 * Caption → Slack `mrkdwn`, sent with `verbatim: true`. `&`, `<` and `>` are the characters Slack
 * says must be escaped — every mention and special command (`<!channel>`, `<@U…>`) is written with
 * angle brackets, so none survives. `verbatim` stops Slack from guessing at names in the rest, which
 * also stops it linking addresses, so each one is written as an explicit `<url>` link here.
 *
 * NOT defused, because Slack offers no escape for them: `*bold*`, `_italic_`, `~strike~` and
 * `` `code` `` still render as formatting.
 */
export function slackMrkdwn(text: string): string {
  // `|` would separate a link from its label inside `<…>`; `findUrls` never includes one.
  return mapAroundUrls(text, slackEscape, (url) => `<${slackEscape(url)}>`);
}

// --- One table for the Composer and the providers -----------------------------------------------

export interface PlatformTextLimit {
  /** The most the platform takes, in `unit`. */
  max: number;
  /** What the platform counts, in words a person reads next to the number. */
  unit: string;
  /** The caption's length as this platform counts it — of the text as it is SENT. */
  length: number;
}

/**
 * How long this caption is on a platform, against that platform's own limit, or null for a
 * platform this file knows nothing about. `hasMedia` matters on Telegram, where text riding on a
 * photo is a caption with a quarter of the room.
 *
 * Telegram and Discord say "characters" without saying which kind; UTF-16 code units are used,
 * the largest of the candidates, so the count can be too strict by an emoji but never too lenient.
 */
export function platformTextLimit(
  provider: string,
  caption: string,
  hasMedia = false,
): PlatformTextLimit | null {
  switch (provider) {
    case 'bluesky':
      return { max: BLUESKY_MAX_GRAPHEMES, unit: 'characters', length: graphemeLength(caption) };
    case 'telegram':
      return {
        max: hasMedia ? TELEGRAM_MAX_CAPTION : TELEGRAM_MAX_TEXT,
        unit: 'characters',
        // "After entities parsing": the three escapes are not counted, so the typed text is.
        length: caption.length,
      };
    case 'discord':
      return {
        max: DISCORD_MAX_CONTENT,
        unit: 'characters',
        length: discordContent(caption).length,
      };
    case 'slack':
      return {
        max: SLACK_MAX_SECTION_TEXT,
        unit: 'characters',
        length: slackMrkdwn(caption).length,
      };
    default:
      return null;
  }
}
