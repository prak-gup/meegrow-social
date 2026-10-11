/**
 * Article body → HTML, for a WordPress post (`postOptions` arm `wordpress`).
 *
 * Kept free of imports and exported on its own subpath,
 * `@meegrow-social/contracts/article-markdown`, for `group-status.ts`'s reason — and so the ONE
 * converter is what both sides run: the provider when it publishes, and the Composer's preview, so
 * the preview cannot show something other than what goes out.
 *
 * The body is Markdown, and ONLY Markdown. Raw HTML in it is escaped and shows up as the text it
 * is: a WordPress Editor or Administrator has `unfiltered_html`, so WordPress itself would store a
 * `<script>` sent with their credentials as a script. Whatever reaches the site's markup has to be
 * built here, from a fixed set of tags, with every attribute value escaped and every URL checked.
 *
 * The subset, chosen to cover an article and nothing clever:
 *   blocks  — `#`…`######` headings, paragraphs, `-`/`*`/`+` and `1.` lists (one level), `>` quotes,
 *             fenced code (three backticks or tildes), `---` rules.
 *   inline  — `**bold**`, `*italic*` (and the `_` forms), `` `code` ``, `[text](url)`,
 *             `![alt](https://image)`, backslash escapes.
 * A single line break inside a paragraph is kept as a `<br />`: the body is typed into a plain
 * text box, where a line break is meant.
 *
 * Links take http(s), mailto and site-relative targets; images take https only. Anything else —
 * `javascript:`, `data:`, a URL with a space — is left as the text that was typed.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/** A link target that is safe to put in an `href`, or null. */
function safeLinkUrl(raw: string): string | null {
  const url = raw.trim();
  if (url === '' || /[\s<>"'`\\]/.test(url) || hasControl(url)) return null;
  if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
  // Site-relative or in-page. `//host` is protocol-relative — another site — so it is not this.
  if (/^(\/(?!\/)|#|\?)/.test(url)) return url;
  return null;
}

/** An image source: https only — an http image on an https article is blocked by browsers anyway. */
function safeImageUrl(raw: string): string | null {
  const url = raw.trim();
  if (/[\s<>"'`\\]/.test(url) || hasControl(url)) return null;
  return /^https:\/\//i.test(url) ? url : null;
}

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Marks a finished piece of HTML inside text that is still being processed. */
const HOLD = '\u0000';

function renderInline(source: string, allowLinks = true): string {
  const held: string[] = [];
  const hold = (html: string): string => `${HOLD}${held.push(html) - 1}${HOLD}`;

  // Code spans first: nothing inside one is markup.
  let text = source.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks, code: string) =>
    hold(`<code>${escapeHtml(code.replace(/\n/g, ' ').trim())}</code>`),
  );
  // A backslash makes the next punctuation character literal.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_m, ch: string) => hold(escapeHtml(ch)));

  text = text.replace(
    /!\[([^\]\n]{0,1000})\]\([ \t]*([^()\s]{1,2048})(?:[ \t]+"([^"\n]{0,500})")?[ \t]*\)/g,
    (whole: string, alt: string, target: string, title?: string) => {
      const src = safeImageUrl(target);
      if (!src) return whole;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return hold(`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titleAttr} />`);
    },
  );
  if (allowLinks) {
    text = text.replace(
      /\[([^\]\n]{1,1000})\]\([ \t]*([^()\s]{1,2048})(?:[ \t]+"([^"\n]{0,500})")?[ \t]*\)/g,
      (whole: string, label: string, target: string, title?: string) => {
        const href = safeLinkUrl(target);
        if (!href) return whole;
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        // The label is rendered with the pieces already held intact, and no link inside a link.
        const inner = renderEmphasis(escapeHtml(label));
        return hold(`<a href="${escapeHtml(href)}"${titleAttr}>${inner}</a>`);
      },
    );
  }

  text = renderEmphasis(escapeHtml(text));
  // Held pieces can contain held pieces (code inside a link label), so resolve until none is left.
  const marker = new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g');
  for (let pass = 0; pass < 4 && text.includes(HOLD); pass++) {
    text = text.replace(marker, (_m, index: string) => held[Number(index)] ?? '');
  }
  return text.split(HOLD).join('');
}

/**
 * Bold and italic, on text that is already HTML-escaped. Every span here and in `renderInline` is
 * length-bounded: an unbounded lazy match restarted at each of thousands of unclosed markers is
 * quadratic, and the body can be 100 000 characters of whatever a caller likes.
 */
function renderEmphasis(escaped: string): string {
  return escaped
    .replace(/\*\*(?=\S)([^\n]{1,1000}?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(
      /(?<![A-Za-z0-9])__(?=\S)([^\n]{1,1000}?)(?<=\S)__(?![A-Za-z0-9])/g,
      '<strong>$1</strong>',
    )
    .replace(/\*(?=\S)([^*\n]{1,1000}?)(?<=\S)\*/g, '<em>$1</em>')
    .replace(/(?<![A-Za-z0-9])_(?=\S)([^_\n]{1,1000}?)(?<=\S)_(?![A-Za-z0-9])/g, '<em>$1</em>');
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const BULLET = /^\s*[-*+][ \t]+(.*)$/;
const NUMBERED = /^\s*\d{1,9}[.)][ \t]+(.*)$/;

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line)
  );
}

function renderBlocks(lines: string[], depth: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trimEnd();
    if (line === '') {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
      const code: string[] = [];
      i++;
      while (i < lines.length && !closing.test(lines[i]!)) code.push(lines[i++]!);
      i++; // the closing fence, or the end of the body when it was never closed
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      // "## Title ##" — the closing hashes are decoration.
      const title = heading[2]!
        .trimEnd()
        .replace(/[ \t]#+$/, '')
        .trimEnd();
      out.push(`<h${level}>${renderInline(title)}</h${level}>`);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(lines[i++]!.replace(QUOTE, ''));
      // A quote inside a quote inside a quote is not an article; past a few levels it is an attack.
      const inner =
        depth < 3 ? renderBlocks(quoted, depth + 1) : [`<p>${renderInline(quoted.join('\n'))}</p>`];
      out.push(`<blockquote>${inner.join('\n')}</blockquote>`);
      continue;
    }

    const list = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (list) {
      const items: string[] = [];
      while (i < lines.length) {
        const item = list.exec(lines[i]!);
        if (item) {
          items.push(item[1]!);
          i++;
        } else if (
          items.length > 0 &&
          /^\s+\S/.test(lines[i]!) &&
          !BULLET.test(lines[i]!) &&
          !NUMBERED.test(lines[i]!)
        ) {
          // An indented line continues the item above it.
          items[items.length - 1] += `\n${lines[i]!.trim()}`;
          i++;
        } else {
          break;
        }
      }
      const tag = list === BULLET ? 'ul' : 'ol';
      const body = items.map((item) => `<li>${renderParagraphText(item)}</li>`).join('\n');
      out.push(`<${tag}>\n${body}\n</${tag}>`);
      continue;
    }

    const paragraph: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== '' && !startsBlock(lines[i]!)) {
      paragraph.push(lines[i++]!);
    }
    out.push(`<p>${renderParagraphText(paragraph.join('\n'))}</p>`);
  }
  return out;
}

function renderParagraphText(text: string): string {
  return renderInline(
    text
      .split('\n')
      .map((l) => l.trim())
      .join('\n'),
  ).replace(/\n/g, '<br />\n');
}

/**
 * Convert an article body to the HTML that is sent to WordPress as `content`. Total: any input
 * produces output, and the output contains no tag or attribute this file did not write.
 */
export function articleMarkdownToHtml(markdown: string): string {
  const lines = markdown.split(HOLD).join('').replace(/\r\n?/g, '\n').split('\n');
  return renderBlocks(lines, 0).join('\n\n');
}

/**
 * The body as plain words — what is left when the markup is taken away. For "is there anything
 * here to publish" and for one-line previews of an article in a list.
 */
export function articleMarkdownToText(markdown: string): string {
  return articleMarkdownToHtml(markdown)
    .replace(/<img [^>]*>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_m, name: string) =>
      name === 'amp'
        ? '&'
        : name === 'lt'
          ? '<'
          : name === 'gt'
            ? '>'
            : name === 'quot'
              ? '"'
              : "'",
    )
    .replace(/\s+/g, ' ')
    .trim();
}
