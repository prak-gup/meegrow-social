import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { postView, type PostView } from '@meegrow-social/contracts';
import { ArticlePreview } from '../components/ArticlePreview';
import {
  BLOG_PAGE_SIZE,
  EMPTY_BLOG_FILTERS,
  articlePreviewText,
  blogChip,
  readBlogSort,
  blogDate,
  blogDateLabel,
  blogSortDate,
  blogSource,
  blogStatus,
  blogStatusLabel,
  blogTitle,
  blogTerms,
  filterBlog,
  isSiteArticle,
  loadBlogInventory,
} from './blog';

function article(patch: Partial<PostView> = {}): PostView {
  return postView.parse({
    id: '00000000-0000-4000-8000-000000000001',
    groupId: '00000000-0000-4000-8000-000000000002',
    connectionId: '00000000-0000-4000-8000-000000000003',
    provider: 'wordpress',
    status: 'published',
    source: 'imported',
    caption: '<h2>Hello</h2><p>First paragraph</p><p>Second</p>',
    createdAt: '2026-10-10T10:00:00Z',
    publishAt: '2026-10-10T10:00:00Z',
    releaseUrl: 'https://example.test/article',
    error: null,
    queueId: null,
    platformRemovedAt: null,
    media: [],
    options: {
      kind: 'wordpress',
      title: 'Short title',
      status: 'draft',
      remote: {
        title: 'Full article headline',
        excerpt: '',
        slug: 'article',
        status: 'draft',
        modifiedAt: '2026-10-10T11:00:00Z',
        publishedAt: null,
        categories: ['News'],
        tags: ['Updates'],
        author: 'Editor',
        bodyFormat: 'html',
        bodyTruncated: false,
      },
    },
    ...patch,
  });
}

describe('Blog inventory and presentation', () => {
  it('lists site drafts and removed articles but excludes unsent posts and other providers', () => {
    const p = article();
    expect(isSiteArticle(p)).toBe(true);
    expect(isSiteArticle(article({ platformRemovedAt: new Date() }))).toBe(true);
    expect(isSiteArticle(article({ status: 'scheduled' }))).toBe(false);
    expect(isSiteArticle(article({ status: 'draft' }))).toBe(false);
    expect(isSiteArticle(article({ provider: 'facebook', options: null }))).toBe(false);
  });
  it('uses full site headline, removal precedence and honest source labels', () => {
    expect(blogTitle(article())).toBe('Full article headline');
    expect(blogSource(article())).toBe('Imported');
    expect(blogSource(article({ source: 'app' }))).toBe('Published here');
    const removed = article({ platformRemovedAt: new Date() });
    expect(blogStatus(removed)).toBe('removed');
    expect(blogChip(removed)).toBe('removed');
    expect(blogStatusLabel(removed)).toBe('Removed');
  });
  it.each([
    ['publish', 'published', 'Published'],
    ['draft', 'site_draft', 'Draft on site'],
    ['pending', 'site_pending', 'Pending'],
    ['future', 'site_future', 'Scheduled'],
    ['private', 'site_private', 'Private'],
  ] as const)(
    'shows site status %s independently of our lifecycle status',
    (status, chip, label) => {
      const p = article();
      if (p.options?.kind === 'wordpress' && p.options.remote) p.options.remote.status = status;
      expect(blogChip(p)).toBe(chip);
      expect(blogStatusLabel(p)).toBe(label);
    },
  );
  it('does not invent dates for undated drafts or older app-published rows', () => {
    expect(blogDate(article(), 'published')).toBeNull();
    expect(blogDate(article(), 'modified')).toBe('2026-10-10T11:00:00Z');
    const older = article({
      source: 'app',
      options: { kind: 'wordpress', title: 'Sent title', status: 'publish' },
    });
    expect(blogTitle(older)).toBe('Sent title');
    expect(blogDate(older, 'published')).toBeNull();
    expect(blogDateLabel('not-a-date')).toBe('—');
    expect(blogDateLabel(null)).toBe('—');
  });
  it('shows older app term names and explicit IDs without inventing resolved site names', () => {
    const p = article({
      source: 'app',
      options: {
        kind: 'wordpress',
        title: 'Sent title',
        status: 'publish',
        categories: ['News', 12],
        tags: ['Updates'],
      },
    });
    expect(blogTerms(p, 'categories')).toEqual(['News', 'Term ID 12']);
    expect(blogTerms(p, 'tags')).toEqual(['Updates']);
    expect(filterBlog([p], { ...EMPTY_BLOG_FILTERS, category: 'News' })).toEqual([p]);
    expect(blogTerms(article(), 'categories')).toEqual(['News']);
  });
  it('combines title search, site, site status and exact category filters', () => {
    const p = article();
    const filters = {
      ...EMPTY_BLOG_FILTERS,
      search: '  ARTICLE HEAD  ',
      status: 'draft',
      category: 'News',
      site: p.connectionId,
    };
    expect(filterBlog([p], filters)).toEqual([p]);
    expect(filterBlog([p], { ...filters, status: 'publish' })).toEqual([]);
    expect(filterBlog([p], { ...filters, category: 'New' })).toEqual([]);
    expect(filterBlog([p], { ...filters, site: 'other' })).toEqual([]);
    expect(filterBlog([p], { ...filters, search: 'paragraph' })).toEqual([]);
  });
  it('sorts dates both ways, keeps missing dates last, breaks ties by ID and preserves input order', () => {
    const a = article();
    const b = article({ id: '00000000-0000-4000-8000-000000000004' });
    const c = article({ id: '00000000-0000-4000-8000-000000000005' });
    if (b.options?.kind === 'wordpress' && b.options.remote)
      b.options.remote.publishedAt = '2026-10-11T00:00:00Z';
    if (c.options?.kind === 'wordpress' && c.options.remote)
      c.options.remote.publishedAt = '2026-10-12T00:00:00Z';
    for (const post of [a, b, c])
      if (post.options?.kind === 'wordpress' && post.options.remote)
        post.options.remote.status = 'publish';
    const input = [a, b, c];
    expect(filterBlog(input, EMPTY_BLOG_FILTERS).map((p) => p.id)).toEqual([c.id, b.id, a.id]);
    expect(filterBlog(input, { ...EMPTY_BLOG_FILTERS, dir: 'asc' }).map((p) => p.id)).toEqual([
      b.id,
      c.id,
      a.id,
    ]);
    expect(input).toEqual([a, b, c]);
    expect(filterBlog([b, a], { ...EMPTY_BLOG_FILTERS, sort: 'title' }).map((p) => p.id)).toEqual([
      b.id,
      a.id,
    ]);
  });
  it('uses draft modification date for newest/oldest and validates URL sorts', () => {
    const draft = article();
    const older = article({ id: '00000000-0000-4000-8000-000000000004' });
    if (older.options?.kind === 'wordpress' && older.options.remote) {
      older.options.remote.status = 'publish';
      older.options.remote.publishedAt = '2026-10-09T00:00:00Z';
    }
    expect(filterBlog([older, draft], EMPTY_BLOG_FILTERS)).toEqual([draft, older]);
    expect(filterBlog([older, draft], { ...EMPTY_BLOG_FILTERS, dir: 'asc' })).toEqual([
      older,
      draft,
    ]);
    expect(readBlogSort('invalid')).toEqual({ sort: 'published', dir: 'desc' });
    expect(readBlogSort('title:asc')).toEqual({ sort: 'title', dir: 'asc' });
  });
  it('sorts legacy app publications by real publishAt without inventing site metadata', () => {
    const app = article({
      source: 'app',
      publishAt: new Date('2026-10-12T00:00:00Z'),
      options: { kind: 'wordpress', title: 'Legacy article', status: 'publish' },
    });
    expect(blogDate(app, 'published')).toBeNull();
    expect(blogSortDate(app, 'published')).toBe(app.publishAt!.getTime());
    expect(filterBlog([article(), app], EMPTY_BLOG_FILTERS)).toEqual([app, article()]);
    const imported = article({
      options: { kind: 'wordpress', title: 'Undated', status: 'publish' },
    });
    expect(blogSortDate(imported, 'published')).toBeNull();
    const draft = article({
      source: 'app',
      options: { kind: 'wordpress', title: 'Draft', status: 'draft' },
    });
    expect(blogSortDate(draft, 'published')).toBeNull();
  });
  it('sorts titles and modification dates independently of publication dates', () => {
    const a = article(),
      b = article({ id: '00000000-0000-4000-8000-000000000004' });
    if (b.options?.kind === 'wordpress' && b.options.remote) {
      b.options.remote.title = 'Zebra';
      b.options.remote.modifiedAt = '2026-10-11T00:00:00Z';
    }
    expect(filterBlog([b, a], { ...EMPTY_BLOG_FILTERS, sort: 'title', dir: 'asc' })).toEqual([
      a,
      b,
    ]);
    expect(filterBlog([a, b], { ...EMPTY_BLOG_FILTERS, sort: 'modified' })).toEqual([b, a]);
  });
});

describe('Blog stored inventory paging', () => {
  it('reads beyond the first page before filtering, deduplicating shifting offsets', async () => {
    const first = Array.from({ length: BLOG_PAGE_SIZE }, (_, i) =>
      article({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
    );
    const last = article({ id: '00000000-0000-4000-8000-000000000100' });
    const read = vi
      .fn()
      .mockResolvedValueOnce({ posts: first })
      .mockResolvedValueOnce({ posts: [first[0], last] });
    const result = await loadBlogInventory(read, () => false);
    expect(result).toHaveLength(BLOG_PAGE_SIZE + 1);
    expect(read.mock.calls).toEqual([
      [{ provider: 'wordpress', status: 'published', limit: BLOG_PAGE_SIZE, offset: 0 }],
      [
        {
          provider: 'wordpress',
          status: 'published',
          limit: BLOG_PAGE_SIZE,
          offset: BLOG_PAGE_SIZE,
        },
      ],
    ]);
    expect(result?.at(-1)).toEqual(last);
  });
  it('advances offsets by raw page length even when rows are excluded', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        posts: Array.from({ length: BLOG_PAGE_SIZE }, () => article({ status: 'scheduled' })),
      })
      .mockResolvedValueOnce({ posts: [article()] });
    expect(await loadBlogInventory(read, () => false)).toEqual([article()]);
    expect(read.mock.calls[1]?.[0].offset).toBe(BLOG_PAGE_SIZE);
  });
  it('does not silently show an incomplete inventory after a page fails', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ posts: Array.from({ length: BLOG_PAGE_SIZE }, () => article()) })
      .mockRejectedValueOnce(new Error('Read failed'));
    await expect(loadBlogInventory(read, () => false)).rejects.toThrow('Read failed');
  });
  it('stops after a client switch or navigation and discards the old result', async () => {
    let stale = false;
    const read = vi.fn().mockImplementation(async () => {
      stale = true;
      return { posts: Array.from({ length: BLOG_PAGE_SIZE }, () => article()) };
    });
    expect(await loadBlogInventory(read, () => stale)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(await loadBlogInventory(read, () => true)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('Escaped article preview', () => {
  it('preserves paragraph and list structure without site styling', () => {
    expect(
      articlePreviewText('<h2>Heading</h2><p>A &amp; B<br>C</p><ul><li>One</li><li>Two</li></ul>'),
    ).toBe('Heading\n\nA & B\n\nC\n\n• One\n• Two');
  });
  it('drops non-visible blocks and comments and tolerates unknown entities and invalid codepoints', () => {
    expect(
      articlePreviewText(
        '<script>alert(1)</script><style>a{}</style><!--secret--><p>&#65; &#x1f600; &#0; &#xD800; &unknown;</p>',
      ),
    ).toBe('A 😀 &#0; &#xD800; &unknown;');
  });
  it.each([
    '<img src="https://example.test/pixel" onerror="alert(1)"><p onclick="alert(2)">Body</p>',
    '<svg/onload=alert(1)><a href="javascript:alert(1)">Click</a><iframe src="https://example.test"></iframe>',
    '&lt;img src=x onerror=alert(1)&gt; &#60;script&#62;alert(1)&#60;/script&#62;',
    '<script>unterminated<script <img src=x onerror=alert(1)>',
  ])('sanitises hostile HTML and escapes the advanced original source: %s', (body) => {
    const markup = renderToStaticMarkup(createElement(ArticlePreview, { body, html: true }));
    expect(markup).not.toMatch(/<(?:script|svg|iframe)\b/i);
    expect(markup).not.toMatch(/<[^>]*\s(?:onerror|onload|onclick)=/i);
    expect(markup).toContain('<pre');
  });
  it('escapes app-published Markdown without interpreting raw HTML', () => {
    const markup = renderToStaticMarkup(
      createElement(ArticlePreview, { body: '# Heading\n<img src=x>', html: false }),
    );
    expect(markup).toContain('# Heading');
    expect(markup).toContain('&lt;img');
    expect(markup).not.toContain('<img');
  });
  it('handles the full stored body limit without executable content', () => {
    const body = '<p>' + 'a'.repeat(99_993) + '</p>';
    expect(articlePreviewText(body)).toHaveLength(99_993);
  });
});
