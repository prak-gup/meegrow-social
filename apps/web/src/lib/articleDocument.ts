import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

type HtmlNode = DefaultTreeAdapterMap['childNode'];
type Element = DefaultTreeAdapterMap['element'];
const isElement = (node: HtmlNode): node is Element => 'tagName' in node;
const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Reject all schemes other than HTTP(S); relative site URLs are deliberately not resolved. */
export function documentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
const allowed = new Set(
  'p h1 h2 h3 h4 h5 h6 strong b em i u s del strike a ul ol li blockquote pre code hr br img figure figcaption table thead tbody tfoot tr th td'.split(
    ' ',
  ),
);
const forbidden = new Set(
  'script style svg math template object form input button textarea select link meta base'.split(
    ' ',
  ),
);
const placeholder = (label: string) =>
  `<div class="wordpress-block" role="note">WordPress block: ${escape(label)}</div>`;
const shortcodePattern = /\[(\/?[a-zA-Z][\w-]*)(?:\s[^\]\n]*)?\s*\/?\]/g;

/** HTML5 parsing handles malformed/nested markup before the strict output allowlist is applied. */
export function sanitiseArticle(html: string): string {
  const render = (node: HtmlNode, depth = 0): string => {
    if (depth > 60) return placeholder('unsupported nested content');
    if (node.nodeName === '#comment' && 'data' in node) {
      const block = node.data
        .trim()
        .match(/^wp:([\w/-]+)/)?.[1]
        ?.replace(/^core\//, '');
      return block && !simpleBlocks.has(block) ? placeholder(block) : '';
    }
    if (node.nodeName === '#text' && 'value' in node)
      return escape(node.value).replace(shortcodePattern, (_, name: string) =>
        placeholder(name.replace(/^\//, '')),
      );
    if (!isElement(node)) return '';
    const tag = node.tagName;
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || forbidden.has(tag)) return '';
    if (['iframe', 'embed', 'video', 'audio'].includes(tag))
      return placeholder(tag === 'iframe' ? 'embed' : tag);
    if (!allowed.has(tag)) return node.childNodes.map((child) => render(child, depth + 1)).join('');
    const attrs: string[] = [];
    const attr = (name: string) => node.attrs.find((a) => a.name === name)?.value;
    if (tag === 'a') {
      const href = documentUrl(attr('href') ?? '');
      if (href)
        attrs.push(`href="${escape(href)}"`, 'target="_blank"', 'rel="noopener noreferrer"');
    }
    if (tag === 'img') {
      const src = documentUrl(attr('src') ?? '');
      if (!src) return '';
      attrs.push(
        `src="${escape(src)}"`,
        `alt="${escape(attr('alt') ?? '')}"`,
        'loading="lazy"',
        'referrerpolicy="no-referrer"',
      );
    }
    if (['td', 'th'].includes(tag)) {
      for (const name of ['colspan', 'rowspan']) {
        const value = attr(name);
        if (value && /^[1-9]\d?$/.test(value)) attrs.push(`${name}="${value}"`);
      }
    }
    if (tag === 'ol' && /^-?\d{1,6}$/.test(attr('start') ?? ''))
      attrs.push(`start="${attr('start')}"`);
    const opening = `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
    return (
      opening +
      (['img', 'hr', 'br'].includes(tag)
        ? ''
        : node.childNodes.map((child) => render(child, depth + 1)).join('') + `</${tag}>`)
    );
  };
  // Unsupported Gutenberg blocks become one card, rather than leaking shortcode or embed internals.
  const analysis = analyseEditability(html);
  if (analysis.kind !== 'source only') {
    return analysis.regions
      .map((region) => {
        if (region.protected && /^<!--\s*wp:/.test(region.html) && !simpleBlocks.has(region.label))
          return placeholder(region.label);
        return parseFragment(region.html)
          .childNodes.map((node) => render(node))
          .join('');
      })
      .join('');
  }
  return parseFragment(html)
    .childNodes.map((node) => render(node))
    .join('');
}

export interface ArticleRegion {
  id: string;
  html: string;
  prefix: string;
  protected: boolean;
  label: string;
  editorHtml: string;
}
export interface Editability {
  kind: 'safe' | 'has protected blocks' | 'source only';
  regions: ArticleRegion[];
  suffix: string;
  protectedCount: number;
  reason?: string;
  classicOnEdit: boolean;
}
const editableTags = new Set(
  'p h2 h3 h4 strong b em i u s del strike a ul ol li blockquote pre code hr br img table thead tbody tr th td'.split(
    ' ',
  ),
);
const simpleBlocks = new Set([
  'paragraph',
  'heading',
  'list',
  'list-item',
  'quote',
  'image',
  'code',
  'table',
  'separator',
]);
function fullyRepresented(node: HtmlNode, depth = 0): boolean {
  if (depth > 60) return false;
  if (node.nodeName === '#text' && 'value' in node)
    return !shortcodePattern.test(((shortcodePattern.lastIndex = 0), node.value));
  if (!isElement(node)) return false;
  if (!editableTags.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml')
    return false;
  const attrs = new Set(
    node.tagName === 'a'
      ? ['href', 'target', 'rel']
      : node.tagName === 'img'
        ? ['src', 'alt', 'title']
        : node.tagName === 'ol'
          ? ['start']
          : ['td', 'th'].includes(node.tagName)
            ? ['colspan', 'rowspan']
            : [],
  );
  if (node.attrs.some((a) => !attrs.has(a.name))) return false;
  if (node.attrs.some((a) => ['href', 'src'].includes(a.name) && !documentUrl(a.value)))
    return false;
  if (
    node.attrs.some((a) => ['colspan', 'rowspan'].includes(a.name) && !/^[1-9]\d?$/.test(a.value))
  )
    return false;
  if (node.attrs.some((a) => a.name === 'start' && !/^-?\d{1,6}$/.test(a.value))) return false;
  return node.childNodes.every((child) => fullyRepresented(child, depth + 1));
}

/** Conservative loss analysis. Source locations retain every protected byte, including comments. */
export function analyseEditability(html: string): Editability {
  const sourceOnly = (reason: string): Editability => ({
    kind: 'source only',
    regions: [],
    suffix: '',
    protectedCount: 0,
    reason,
    classicOnEdit: false,
  });
  if (html.length > 100_000) return sourceOnly('Body is too large for safe rich editing.');
  let parseError = false;
  const root = parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError: () => {
      parseError = true;
    },
  });
  if (parseError) return sourceOnly('Malformed HTML requires source editing.');
  const regions: ArticleRegion[] = [];
  let cursor = 0;
  let blockStart = -1;
  let blockName = '';
  let blockAttributesProtected = false;
  const stack: string[] = [];
  let hasComments = false;
  const add = (
    start: number,
    end: number,
    label: string,
    protectedBlock: boolean,
    editorHtml: string,
  ) => {
    if (start < cursor || end < start) return false;
    regions.push({
      id: `region-${regions.length}`,
      html: html.slice(start, end),
      prefix: html.slice(cursor, start),
      protected: protectedBlock,
      label,
      editorHtml,
    });
    cursor = end;
    return true;
  };
  for (const node of root.childNodes) {
    const loc = node.sourceCodeLocation;
    if (!loc) return sourceOnly('The HTML parser repaired a structure; use source editing.');
    if (node.nodeName === '#comment' && 'data' in node) {
      const match = node.data.trim().match(/^(\/?)wp:([\w/-]+)(?:\s.*)?$/s);
      if (match) {
        hasComments = true;
        const name = match[2]!.replace(/^core\//, '');
        if (match[1]) {
          if (stack.pop() !== name) return sourceOnly('Unbalanced WordPress block comments.');
          if (!stack.length) {
            const raw = html.slice(blockStart, loc.endOffset);
            const inner = raw.replace(/<!--\s*\/?wp:[\s\S]*?-->/g, '');
            const parsed = parseFragment(inner);
            const protectedBlock =
              blockAttributesProtected ||
              !simpleBlocks.has(blockName) ||
              !parsed.childNodes.every((child) => fullyRepresented(child)) ||
              /<!--\s*wp:[\s\S]*?-->/g.test(inner);
            if (!add(blockStart, loc.endOffset, blockName, protectedBlock, inner))
              return sourceOnly('Overlapping block structure.');
          }
        } else {
          if (!stack.length) {
            blockStart = loc.startOffset;
            blockName = name;
            blockAttributesProtected = false;
          }
          const json = node.data.match(/\{[\s\S]*\}/)?.[0];
          if (json) {
            try {
              const attributes: unknown = JSON.parse(json);
              const allowedAttributes =
                name === 'heading' ? ['level'] : name === 'list' ? ['ordered', 'start'] : [];
              if (
                !attributes ||
                typeof attributes !== 'object' ||
                Array.isArray(attributes) ||
                Object.keys(attributes).some((key) => !allowedAttributes.includes(key))
              )
                blockAttributesProtected = true;
            } catch {
              return sourceOnly('Invalid WordPress block attributes.');
            }
          }
          if (/\/\s*$/.test(node.data)) {
            if (!stack.length) add(loc.startOffset, loc.endOffset, name, true, '');
          } else stack.push(name);
        }
        continue;
      }
      if (!stack.length) add(loc.startOffset, loc.endOffset, 'custom HTML', true, '');
    } else if (!stack.length) {
      if (node.nodeName === '#text' && 'value' in node && !node.value.trim()) continue;
      const represented = isElement(node) && fullyRepresented(node);
      const raw = html.slice(loc.startOffset, loc.endOffset);
      const shortcode = raw.match(/\[([a-zA-Z][\w-]*)[\s\]]/);
      if (
        !add(
          loc.startOffset,
          loc.endOffset,
          shortcode ? `shortcode ${shortcode[1]}` : isElement(node) ? node.tagName : 'custom HTML',
          !represented,
          raw,
        )
      )
        return sourceOnly('Overlapping HTML structure.');
    }
  }
  if (stack.length) return sourceOnly('Unbalanced WordPress block comments.');
  if (regions.length > 400) return sourceOnly('Too many regions for safe rich editing.');
  if (!regions.length)
    regions.push({
      id: 'region-0',
      html: '',
      prefix: '',
      protected: false,
      label: 'paragraph',
      editorHtml: '<p></p>',
    });
  // Blank editable regions let operators add text around a run of locked blocks.
  const withGaps: ArticleRegion[] = [];
  for (const region of regions) {
    if (region.protected && (!withGaps.length || withGaps[withGaps.length - 1]!.protected))
      withGaps.push({
        id: '',
        html: '',
        prefix: '',
        protected: false,
        label: 'paragraph',
        editorHtml: '<p></p>',
      });
    withGaps.push(region);
  }
  if (withGaps[withGaps.length - 1]?.protected)
    withGaps.push({
      id: '',
      html: '',
      prefix: '',
      protected: false,
      label: 'paragraph',
      editorHtml: '<p></p>',
    });
  regions.splice(
    0,
    regions.length,
    ...withGaps.map((region, i) => ({ ...region, id: `region-${i}` })),
  );
  const protectedCount = regions.filter((r) => r.protected).length;
  return {
    kind: protectedCount ? 'has protected blocks' : 'safe',
    regions,
    suffix: html.slice(cursor),
    protectedCount,
    classicOnEdit: hasComments,
  };
}

export interface RegionEdit {
  id: string;
  html: string;
  changed: boolean;
  protected: boolean;
}
/** A missing, reordered or altered lock fails closed. Unedited regions always use original bytes. */
export function serialiseArticle(analysis: Editability, edits: RegionEdit[]): string {
  if (analysis.kind === 'source only') throw new Error('Rich editing is unavailable.');
  if (
    edits.length !== analysis.regions.length ||
    edits.some((edit, i) => edit.id !== analysis.regions[i]?.id)
  )
    throw new Error('An original region was removed or reordered. Undo the change before saving.');
  return (
    edits
      .map((edit, i) => {
        const region = analysis.regions[i]!;
        if (region.protected && (edit.changed || !edit.protected))
          throw new Error('A protected WordPress block was changed. Undo before saving.');
        return region.prefix + (edit.changed ? edit.html : region.html);
      })
      .join('') + analysis.suffix
  );
}

/** Preserve spelling/whitespace/markup for text-only edits; fall back if parsing normalized text. */
export function patchArticleText(html: string, before: string[], after: string[]): string | null {
  const nodes: Array<{ value: string; start: number; end: number }> = [];
  const collect = (node: HtmlNode) => {
    if (node.nodeName === '#text' && 'value' in node && node.sourceCodeLocation) {
      // Whitespace between block tags isn't editor text.
      if (
        node.value.trim() ||
        (node.parentNode &&
          isElement(node.parentNode as HtmlNode) &&
          !['table', 'tbody', 'thead', 'tr', 'ul', 'ol'].includes(
            (node.parentNode as Element).tagName,
          ))
      )
        nodes.push({
          value: node.value,
          start: node.sourceCodeLocation.startOffset,
          end: node.sourceCodeLocation.endOffset,
        });
    } else if (isElement(node)) node.childNodes.forEach(collect);
  };
  parseFragment(html, { sourceCodeLocationInfo: true }).childNodes.forEach(collect);
  if (
    nodes.length !== before.length ||
    before.length !== after.length ||
    nodes.some((node, i) => node.value !== before[i])
  )
    return null;
  let result = html;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    const next = after[i]!;
    if (node.value === next) continue;
    let prefix = 0;
    while (
      prefix < node.value.length &&
      prefix < next.length &&
      node.value[prefix] === next[prefix]
    )
      prefix++;
    let suffix = 0;
    while (
      suffix < node.value.length - prefix &&
      suffix < next.length - prefix &&
      node.value[node.value.length - suffix - 1] === next[next.length - suffix - 1]
    )
      suffix++;
    const raw = html.slice(node.start, node.end);
    const offsets = new Map<number, number>([[0, 0]]);
    let decoded = '';
    for (const match of raw.matchAll(/&(?:#x[\da-f]+;?|#\d+;?|[a-z][\da-z]*;?)|\r\n|[\s\S]/gi)) {
      const token = match[0];
      const value =
        token.startsWith('&') || token.includes('\r')
          ? parseFragment(token)
              .childNodes.map((n) => (n.nodeName === '#text' && 'value' in n ? n.value : ''))
              .join('')
          : token;
      decoded += value;
      offsets.set(decoded.length, match.index + token.length);
    }
    if (decoded !== node.value) return null;
    const start = offsets.get(prefix);
    const end = offsets.get(node.value.length - suffix);
    if (start === undefined || end === undefined) return null;
    result =
      result.slice(0, node.start + start) +
      escape(next.slice(prefix, next.length - suffix)) +
      result.slice(node.start + end);
  }
  return result;
}
