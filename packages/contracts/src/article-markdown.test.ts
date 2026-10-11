import { describe, expect, it } from 'vitest';
import {
  articleMarkdownToHtml as html,
  articleMarkdownToText as text,
} from './article-markdown.js';

describe('articleMarkdownToHtml — blocks', () => {
  it('turns blank-line-separated text into paragraphs', () => {
    expect(html('First.\n\nSecond.')).toBe('<p>First.</p>\n\n<p>Second.</p>');
  });

  it('keeps a single line break, because the body is typed into a plain text box', () => {
    expect(html('Line one\nLine two')).toBe('<p>Line one<br />\nLine two</p>');
  });

  it('renders every heading level, and drops closing hashes', () => {
    expect(html('# One')).toBe('<h1>One</h1>');
    expect(html('###### Six')).toBe('<h6>Six</h6>');
    expect(html('## Title ##')).toBe('<h2>Title</h2>');
    // Seven hashes, or no space, is not a heading.
    expect(html('####### Seven')).toBe('<p>####### Seven</p>');
    expect(html('#hashtag')).toBe('<p>#hashtag</p>');
  });

  it('renders bulleted and numbered lists, with continuation lines', () => {
    expect(html('- one\n- two\n  still two\n* three')).toBe(
      '<ul>\n<li>one</li>\n<li>two<br />\nstill two</li>\n<li>three</li>\n</ul>',
    );
    expect(html('1. first\n2) second')).toBe('<ol>\n<li>first</li>\n<li>second</li>\n</ol>');
  });

  it('ends a paragraph at a list, a heading or a quote without a blank line', () => {
    expect(html('Intro:\n- a\n- b')).toBe('<p>Intro:</p>\n\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    expect(html('Text\n## Next')).toBe('<p>Text</p>\n\n<h2>Next</h2>');
  });

  it('renders quotes, including blocks inside them', () => {
    expect(html('> Quoted\n> again')).toBe('<blockquote><p>Quoted<br />\nagain</p></blockquote>');
    expect(html('> # Head\n>\n> body')).toBe('<blockquote><h1>Head</h1>\n<p>body</p></blockquote>');
  });

  it('stops nesting quotes after a few levels instead of recursing forever', () => {
    const out = html(`${'> '.repeat(500)}deep`);
    expect(out.match(/<blockquote>/g)).toHaveLength(4);
    expect(out).toContain('deep');
  });

  it('renders fenced code verbatim and escaped, closed or not', () => {
    expect(html('```\n<b>**not bold**</b>\n```')).toBe(
      '<pre><code>&lt;b&gt;**not bold**&lt;/b&gt;</code></pre>',
    );
    expect(html('~~~js\nconst a = 1;\n~~~\nafter')).toBe(
      '<pre><code>const a = 1;</code></pre>\n\n<p>after</p>',
    );
    expect(html('```\nnever closed')).toBe('<pre><code>never closed</code></pre>');
  });

  it('renders a rule', () => {
    expect(html('a\n\n---\n\nb')).toBe('<p>a</p>\n\n<hr />\n\n<p>b</p>');
    expect(html('* * *')).toBe('<hr />');
  });

  it('is empty for an empty or whitespace-only body', () => {
    expect(html('')).toBe('');
    expect(html('  \n\n\t\n')).toBe('');
  });

  it('accepts Windows line endings', () => {
    expect(html('a\r\n\r\nb')).toBe('<p>a</p>\n\n<p>b</p>');
  });
});

describe('articleMarkdownToHtml — inline', () => {
  it('renders bold, italic and code', () => {
    expect(html('**bold** and *italic* and `code`')).toBe(
      '<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>',
    );
    expect(html('__bold__ and _italic_')).toBe('<p><strong>bold</strong> and <em>italic</em></p>');
  });

  it('leaves snake_case and stray markers alone', () => {
    expect(html('some_var_name and 2 * 3 * 4')).toBe('<p>some_var_name and 2 * 3 * 4</p>');
  });

  it('treats nothing inside a code span as markup', () => {
    expect(html('`**x** <i>`')).toBe('<p><code>**x** &lt;i&gt;</code></p>');
  });

  it('honours backslash escapes', () => {
    expect(html('\\*not italic\\* and \\# not a heading')).toBe(
      '<p>*not italic* and # not a heading</p>',
    );
  });

  it('renders links to http(s), mailto and site-relative targets', () => {
    expect(html('[site](https://example.com/a?b=1&c=2)')).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2">site</a></p>',
    );
    expect(html('[mail](mailto:hi@example.com)')).toBe(
      '<p><a href="mailto:hi@example.com">mail</a></p>',
    );
    expect(html('[about](/about) [top](#top)')).toBe(
      '<p><a href="/about">about</a> <a href="#top">top</a></p>',
    );
    expect(html('[t](https://example.com "A title")')).toBe(
      '<p><a href="https://example.com" title="A title">t</a></p>',
    );
    expect(html('[**bold** label](https://example.com)')).toBe(
      '<p><a href="https://example.com"><strong>bold</strong> label</a></p>',
    );
  });

  it('renders https images, and an image as a link label', () => {
    expect(html('![A chart](https://cdn.example.com/c.png)')).toBe(
      '<p><img src="https://cdn.example.com/c.png" alt="A chart" /></p>',
    );
    expect(html('[![logo](https://cdn.example.com/l.png)](https://example.com)')).toBe(
      '<p><a href="https://example.com"><img src="https://cdn.example.com/l.png" alt="logo" /></a></p>',
    );
  });

  it('does not emphasise inside a URL', () => {
    expect(html('[x](https://example.com/a_b_c/*d*)')).toBe(
      '<p><a href="https://example.com/a_b_c/*d*">x</a></p>',
    );
  });
});

/**
 * The converter is the only thing between a caller and the markup of a client's website, sent with
 * credentials that WordPress trusts to post unfiltered HTML. Every case below must come out inert.
 */
describe('articleMarkdownToHtml — nothing a caller writes becomes markup', () => {
  const TAGS = new Set([
    'p',
    'br',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'hr',
    'strong',
    'em',
    'a',
    'img',
  ]);
  const ATTRS = new Set(['href', 'title', 'src', 'alt']);

  /** Every tag and attribute in the output must be one this converter writes. */
  function assertInert(out: string): void {
    for (const tag of out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*)?)\/?>/g)) {
      expect(TAGS.has(tag[1]!.toLowerCase()), `unexpected <${tag[1]}> in ${out}`).toBe(true);
      const attrs = tag[2]!.replace(/"[^"]*"/g, '""');
      for (const attr of attrs.matchAll(/([a-zA-Z-]+)=/g)) {
        expect(ATTRS.has(attr[1]!.toLowerCase()), `unexpected ${attr[1]}= in ${out}`).toBe(true);
      }
    }
    // No tag is left that the pattern above could not read.
    expect(out.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^<>]*)?\/?>/g, '')).not.toMatch(/[<>]/);
    for (const url of out.matchAll(/(?:href|src)="([^"]*)"/g)) {
      expect(url[1]).toMatch(/^(https?:\/\/|mailto:|\/(?!\/)|#|\?)/i);
    }
  }

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg/onload=alert(1)>',
    '<!-- wp:html --><script>alert(1)</script><!-- /wp:html -->',
    '</p><script>alert(1)</script>',
    '# <script>alert(1)</script>',
    '- <script>alert(1)</script>',
    '> <script>alert(1)</script>',
    '**<script>alert(1)</script>**',
    '`<script>`',
    '```\n</code></pre><script>alert(1)</script>\n```',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '[x](vbscript:msgbox(1))',
    '[x](//evil.example/path)',
    '[x](https://example.com/"onmouseover="alert(1))',
    '[x](https://example.com "title\\" onmouseover=\\"alert(1)")',
    '[x](https://example.com "\'><script>alert(1)</script>")',
    '![x](javascript:alert(1))',
    '![x](http://example.com/a.png)',
    '![x](data:image/svg+xml,<svg onload=alert(1)>)',
    '!["onerror="alert(1)](https://example.com/a.png)',
    '![a](https://example.com/a.png "t\\" onerror=\\"alert(1)")',
    '[<img src=x onerror=alert(1)>](https://example.com)',
    '[a](https://example.com)<script>alert(1)</script>',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '\u00000\u0000<script>alert(1)</script>',
    '[x](https://example.com/\u0001)',
    '[x](java\tscript:alert(1))',
  ])('keeps %j inert', (input) => {
    const out = html(input);
    assertInert(out);
    // The words may survive as text (that is the point); what must not is a tag or a live URL.
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/(?:href|src)="\s*(?:javascript|data|vbscript):/i);
  });

  it('shows raw HTML as the text that was typed', () => {
    expect(html('<b>hi</b>')).toBe('<p>&lt;b&gt;hi&lt;/b&gt;</p>');
  });

  it('leaves an unsafe link as text rather than dropping it silently', () => {
    expect(html('[x](javascript:alert(1))')).toBe('<p>[x](javascript:alert(1))</p>');
  });

  it('cannot be made to emit a held-piece marker from the input', () => {
    expect(html('\u00000\u0000 `code`')).toBe('<p>0 <code>code</code></p>');
  });

  it.each([
    ['unclosed bold', '**a '.repeat(25_000)],
    ['unclosed brackets', '['.repeat(100_000)],
    ['unclosed image', '!['.repeat(50_000)],
    ['unclosed code', '`a ``b '.repeat(14_000)],
    ['underscores', '__a '.repeat(25_000)],
    ['heading padded with tabs', `# ${'\t'.repeat(99_000)}x`],
    ['one enormous line', 'word '.repeat(20_000)],
    ['quote markers', '> '.repeat(50_000)],
  ])('stays fast on a hostile 100 000-character body: %s', (_name, input) => {
    const started = Date.now();
    assertInert(html(input));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('articleMarkdownToText', () => {
  it('leaves the words', () => {
    expect(text('# Title\n\nSome **bold** [link](https://example.com) & more.')).toBe(
      'Title Some bold link & more.',
    );
    expect(text('- a\n- b\n\n> c')).toBe('a b c');
  });

  it('is empty when the body is only markup', () => {
    expect(text('   \n\n')).toBe('');
    expect(text('---')).toBe('');
    expect(text('![](https://example.com/a.png)')).toBe('');
  });

  it('gives typed HTML back as text, not as a tag', () => {
    expect(text('<b>x</b>')).toBe('<b>x</b>');
  });
});
