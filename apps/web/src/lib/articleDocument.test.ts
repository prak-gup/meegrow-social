import { describe, expect, it } from 'vitest';
import { analyseEditability, sanitiseArticle, serialiseArticle } from './articleDocument';

import { articleFixtures } from './articleFixtures';

describe('strict article sanitiser', () => {
  it.each([
    '<script>alert(1)</script><p onclick="evil()">Text</p>',
    '<img src="https://example.invalid/image" onerror="evil()"><a href="javascript:evil()">Link</a>',
    '<svg><foreignObject><p onload="evil()">nested</p></foreignObject></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=evil()>">',
    '<style>body{display:none}</style><p style="background:url(javascript:evil())">Text</p>',
    '<form action="https://example.invalid"><input value="bad"></form><object data="https://example.invalid"></object>',
    '<a href="java&#x09;script:evil()">Bad</a><img src="data:image/svg+xml;base64,PHN2Zz4=">',
    '<a href="data:text/html,bad">Bad</a><img src="javascript:evil()">',
  ])('drops hostile HTML: %s', (html) => {
    const clean = sanitiseArticle(html);
    expect(clean).not.toMatch(/<(script|style|svg|math|form|input|object|iframe)\b/i);
    expect(clean).not.toMatch(/\son\w+=|\sstyle=|javascript:|data:/i);
    // Parsing and sanitising again cannot resurrect executable markup.
    expect(sanitiseArticle(clean)).not.toMatch(/<(script|style|svg|iframe)\b|\son\w+=/i);
  });
  it('renders document constructs, secures links and lazy loads images', () => {
    const clean = sanitiseArticle(
      '<h2>Heading</h2><a href="https://example.invalid">Link</a><img src="https://example.invalid/image.jpg" alt="Photo"><table><tr><td>Cell</td></tr></table><pre><code>code</code></pre>',
    );
    expect(clean).toContain('<h2>Heading</h2>');
    expect(clean).toContain('target="_blank" rel="noopener noreferrer"');
    expect(clean).toContain('loading="lazy"');
    expect(clean).toContain('<table>');
    expect(clean).toContain('<pre><code>code</code></pre>');
  });
  it('hides block comments and labels shortcode/unsupported blocks', () => {
    expect(sanitiseArticle(articleFixtures[1])).not.toContain('<!--');
    expect(sanitiseArticle(articleFixtures[8])).toContain('WordPress block: gallery');
    expect(sanitiseArticle(articleFixtures[8])).not.toContain('[gallery');
    expect(sanitiseArticle(articleFixtures[4])).toContain('WordPress block: gallery');
    expect(sanitiseArticle(articleFixtures[5])).toContain('WordPress block: embed');
    expect(sanitiseArticle(articleFixtures[6])).toContain('WordPress block: columns');
  });
});
describe('editability analysis and original-byte safety', () => {
  it('accepts only editor-representable constructs', () => {
    expect(analyseEditability(articleFixtures[0]).kind).toBe('safe');
    expect(analyseEditability(articleFixtures[1]).kind).toBe('safe');
    expect(analyseEditability(articleFixtures[10]).kind).toBe('safe');
  });
  it.each([2, 4, 5, 6, 7, 8, 9, 12])('locks unsupported fixture %s', (index) => {
    expect(analyseEditability(articleFixtures[index]).kind).toBe('has protected blocks');
  });
  it.each([
    '<p class="important">Text</p>',
    '<p style="text-align:center">Text</p>',
    '<a href="/relative">Link</a>',
  ])('locks meaningful attributes: %s', (html) => {
    expect(analyseEditability(html).protectedCount).toBe(1);
  });
  it.each([
    '<!-- wp:columns --><p>Incomplete</p>',
    '<!-- /wp:paragraph -->',
    '<!-- wp:paragraph --><p>Bad</p><!-- /wp:heading -->',
    '<p>Too long</p>'.repeat(10_000),
    '<p>x</p>'.repeat(401),
  ])('uses source only for unsafe/complex structure', (html) => {
    expect(analyseEditability(html).kind).toBe('source only');
  });
  it.each(articleFixtures)('retains an unedited original byte-for-byte: %s', (html) => {
    const analysis = analyseEditability(html);
    expect(
      serialiseArticle(
        analysis,
        analysis.regions.map((r) => ({
          id: r.id,
          protected: r.protected,
          changed: false,
          html: '<p>normalised</p>',
        })),
      ),
    ).toBe(html);
  });
  it('edits only surrounding text and rejects loss, reordering or modification of a locked block', () => {
    const html = articleFixtures[4];
    const analysis = analyseEditability(html);
    const edits = analysis.regions.map((r) => ({
      id: r.id,
      protected: r.protected,
      changed: false,
      html: '',
    }));
    edits[0] = { ...edits[0], changed: true, html: '<p>Updated gallery introduction</p>' };
    expect(serialiseArticle(analysis, edits)).toBe(
      html.replace('Before gallery', 'Updated gallery introduction'),
    );
    expect(() =>
      serialiseArticle(
        analysis,
        edits.filter((r) => !r.protected),
      ),
    ).toThrow('removed or reordered');
    expect(() => serialiseArticle(analysis, [...edits].reverse())).toThrow('removed or reordered');
    expect(() =>
      serialiseArticle(
        analysis,
        edits.map((r) => ({ ...r, changed: true })),
      ),
    ).toThrow('protected');
  });
});
