import { describe, expect, it, vi } from 'vitest';
import { ARTICLE_BODY_MAX, parseStoredOptions } from '@meegrow-social/contracts';
import { WordPressProvider } from './wordpress.js';
import { encodeCredentials, type WordPressFetch } from './client.js';
import { encodeMethodCall } from './xmlrpc.js';
import { articleDate } from './articles.js';
import { ProviderAuthError } from '../../errors.js';

// Documentation-built, never obtained by contacting a site: REST posts schema / wp.getPosts.
const site = 'https://blog.example.test';
const rest = {
  accessToken: encodeCredentials({
    siteUrl: site,
    apiRoot: `${site}/wp-json/`,
    username: 'editor',
    password: 'fixture-secret',
  }),
  externalId: site,
  displayName: 'Blog',
};
const xml = {
  ...rest,
  accessToken: encodeCredentials({
    transport: 'xmlrpc',
    siteUrl: site,
    endpoint: `${site}/xmlrpc.php`,
    username: 'editor',
    password: 'fixture-secret',
  }),
};
const query = { since: new Date('2026-10-01'), limit: 2 };
const post = {
  id: 12,
  title: { raw: 'A &amp; B' },
  content: { raw: '<p>A <strong>blog</strong></p>' },
  excerpt: { raw: '<p>Summary</p>' },
  slug: 'a-b',
  status: 'draft',
  date_gmt: '2020-01-01T10:00:00',
  modified_gmt: '2026-10-10T11:00:00',
  link: `${site}/?p=12`,
  categories: [3],
  tags: [4],
  author: 7,
  featured_media: 9,
  _embedded: {
    author: [{ name: 'Editor' }],
    'wp:term': [
      [{ id: 3, taxonomy: 'category', name: 'News' }],
      [{ id: 4, taxonomy: 'post_tag', name: 'Dental' }],
    ],
    'wp:featuredmedia': [{ source_url: `${site}/image.jpg` }],
  },
};
const xp = {
  post_id: '12',
  post_title: 'A &amp; B',
  post_content: post.content.raw,
  post_excerpt: post.excerpt.raw,
  post_name: 'a-b',
  post_status: 'draft',
  post_date_gmt: '20200101T10:00:00',
  post_modified_gmt: '20261010T11:00:00',
  link: post.link,
  post_author: '7',
  post_thumbnail: { attachment_id: '9', link: `${site}/image.jpg` },
  terms: [
    { term_id: '3', taxonomy: 'category', name: 'News' },
    { term_id: '4', taxonomy: 'post_tag', name: 'Dental' },
  ],
};
// Reuse the tested XML value encoder; the response envelope is specified by XML-RPC.
const responseXml = (value: Parameters<typeof encodeMethodCall>[1][number]) =>
  encodeMethodCall('fixture', [value])
    .replace(/<methodCall><methodName>fixture<\/methodName>/, '<methodResponse>')
    .replace('</methodCall>', '</methodResponse>');
const fault = (code: number) =>
  `<?xml version="1.0"?><methodResponse><fault><value><struct><member><name>faultCode</name><value><int>${code}</int></value></member><member><name>faultString</name><value><string>Missing</string></value></member></struct></value></fault></methodResponse>`;
const answer = (body: unknown, headers = { 'x-wp-totalpages': '2' }, status = 200) => ({
  status,
  headers,
  body: Buffer.from(JSON.stringify(body)),
  url: site,
});

function provider(body: unknown, headers = { 'x-wp-totalpages': '2' }, status = 200) {
  const fetchImpl = vi.fn(async () => answer(body, headers, status));
  return { provider: new WordPressProvider({ fetchImpl }), fetchImpl };
}

describe('WordPress article inventory', () => {
  it('REST lists every site status in edit context, keeps HTML and metadata, uses total pages', async () => {
    const { provider: wp, fetchImpl } = provider([post]);
    const page = await wp.listPublishedPosts(rest, query);
    const article = page.items[0]!;
    expect(article.caption).toBe(post.content.raw);
    expect(article.options).toMatchObject({
      kind: 'wordpress',
      title: 'A & B',
      remote: {
        status: 'draft',
        modifiedAt: '2026-10-10T11:00:00.000Z',
        categories: ['News'],
        tags: ['Dental'],
        author: 'Editor',
        bodyFormat: 'html',
        bodyTruncated: false,
      },
    });
    expect(parseStoredOptions(article.options)).toEqual(article.options);
    expect(article.thumbnailUrl).toBe(`${site}/image.jpg`);
    expect(page.nextCursor).toBe('1');
    const url = new URL(fetchImpl.mock.calls[0]![0] as unknown as string);
    expect(url.searchParams.get('context')).toBe('edit');
    expect(url.searchParams.get('status')).toBe('publish,draft,pending,future,private');
    expect(url.searchParams.get('after')).toBeNull();
    await wp.listPublishedPosts(rest, { ...query, cursor: '1' });
    expect(new URL(fetchImpl.mock.calls[1]![0] as unknown as string).searchParams.get('page')).toBe(
      '2',
    );
  });

  it.each(['publish', 'draft', 'pending', 'future', 'private'])(
    'retains %s separately from our lifecycle status',
    async (status) => {
      const { provider: wp } = provider([{ ...post, status }], { 'x-wp-totalpages': '1' });
      const page = await wp.listPublishedPosts(rest, query);
      expect(page.items[0]!.options).toMatchObject({ remote: { status } });
      expect(page.nextCursor).toBeNull();
    },
  );

  it('follows up for missing embeddings, without sending a credential to a media URL', async () => {
    const fetchImpl: WordPressFetch = vi.fn(async (url) => {
      if (url.includes('/posts'))
        return answer([{ ...post, _embedded: undefined }], { 'x-wp-totalpages': '1' });
      if (url.includes('/media/')) return answer({ source_url: `${site}/image.jpg` });
      if (url.includes('/users/')) return answer({ name: 'Editor' });
      return answer({ name: url.includes('/categories/') ? 'News' : 'Dental' });
    });
    const wp = new WordPressProvider({ fetchImpl });
    expect((await wp.listPublishedPosts(rest, query)).items[0]!.options).toMatchObject({
      remote: { categories: ['News'], tags: ['Dental'], author: 'Editor' },
    });
    expect(
      vi.mocked(fetchImpl).mock.calls.every(([url]) => url.startsWith(`${site}/wp-json/`)),
    ).toBe(true);
  });

  it('caps stored HTML and explicitly flags truncation', async () => {
    const { provider: wp } = provider([
      { ...post, content: { raw: 'x'.repeat(ARTICLE_BODY_MAX + 1) } },
    ]);
    const article = (await wp.listPublishedPosts(rest, query)).items[0]!;
    expect(article.caption.length).toBe(ARTICLE_BODY_MAX);
    expect(article.options).toMatchObject({ remote: { bodyTruncated: true } });
  });

  it('refuses malformed dates, cursors and missing pagination rather than silently losing articles', async () => {
    const { provider: wp } = provider([post], {} as { 'x-wp-totalpages': string });
    await expect(wp.listPublishedPosts(rest, query)).rejects.toThrow('pagination');
    await expect(wp.listPublishedPosts(rest, { ...query, cursor: '-1' })).rejects.toThrow('cursor');
    expect(() => articleDate('')).toThrow('GMT date');
  });

  it('XML-RPC pages by offset and normalises the same article', async () => {
    const fetchImpl: WordPressFetch = vi.fn(async (_url, options) => ({
      status: 200,
      headers: {},
      url: site,
      body: Buffer.from(
        String(options?.body).includes('wp.getUser')
          ? responseXml({ display_name: 'Editor' })
          : responseXml([xp, { ...xp, post_id: '13' }]),
      ),
    }));
    const wp = new WordPressProvider({ fetchImpl });
    const page = await wp.listPublishedPosts(xml, query);
    expect(page.items[0]!.options).toMatchObject({
      title: 'A & B',
      remote: { author: 'Editor', categories: ['News'], tags: ['Dental'], status: 'draft' },
    });
    expect(page.nextCursor).toBe('2');
    await wp.listPublishedPosts(xml, { ...query, cursor: '2' });
    expect(String(vi.mocked(fetchImpl).mock.calls[2]![1]?.body)).toContain(
      '<name>offset</name><value><int>2</int>',
    );
    expect(String(vi.mocked(fetchImpl).mock.calls[0]![1]?.body)).toContain(
      'publish,draft,pending,future,private',
    );
  });

  it('XML-RPC ends on a short page', async () => {
    const wp = new WordPressProvider({
      fetchImpl: async () => ({
        status: 200,
        headers: {},
        url: site,
        body: Buffer.from(responseXml([])),
      }),
    });
    expect((await wp.listPublishedPosts(xml, query)).nextCursor).toBeNull();
  });

  it('REST distinguishes a missing post from failed or refused reads', async () => {
    expect(
      await provider({ id: 12, status: 'draft' }).provider.publishedPostPresence(rest, '12'),
    ).toBe('present');
    expect(
      await provider({ id: 12, status: 'trash' }).provider.publishedPostPresence(rest, '12'),
    ).toBe('gone');
    expect(
      await provider(
        { code: 'rest_post_invalid_id' },
        undefined,
        404,
      ).provider.publishedPostPresence(rest, '12'),
    ).toBe('gone');
    expect(
      await provider({ code: 'rest_forbidden' }, undefined, 403).provider.publishedPostPresence(
        rest,
        '12',
      ),
    ).toBe('unknown');
    const wp = new WordPressProvider({
      fetchImpl: async () => {
        throw new ProviderAuthError('Refused');
      },
    });
    expect(await wp.publishedPostPresence(rest, '12')).toBe('unknown');
  });

  it('XML-RPC only marks gone on a confirmed 404 or trash', async () => {
    for (const [body, presence] of [
      [responseXml({ post_id: '12', post_status: 'private' }), 'present'],
      [responseXml({ post_id: '12', post_status: 'trash' }), 'gone'],
      [fault(404), 'gone'],
      [fault(500), 'unknown'],
    ] as const) {
      const wp = new WordPressProvider({
        fetchImpl: async () => ({ status: 200, headers: {}, url: site, body: Buffer.from(body) }),
      });
      expect(await wp.publishedPostPresence(xml, '12')).toBe(presence);
    }
  });
});

it('imports an undated REST draft using modification time for Calendar, without inventing a publication date', async () => {
  const { provider: wp } = provider([{ ...post, date_gmt: null }], { 'x-wp-totalpages': '1' });
  const article = (await wp.listPublishedPosts(rest, query)).items[0]!;
  expect(article.publishedAt.toISOString()).toBe('2026-10-10T11:00:00.000Z');
  expect(article.options).toMatchObject({ remote: { publishedAt: null, status: 'draft' } });
});

it('refuses republishing imported HTML (including truncated HTML) through the Markdown path', async () => {
  const { provider: wp } = provider([
    { ...post, content: { raw: 'x'.repeat(ARTICLE_BODY_MAX + 1) } },
  ]);
  const imported = (await wp.listPublishedPosts(rest, query)).items[0]!;
  expect(() =>
    wp.assertPublishable([{ caption: imported.caption, media: [], options: imported.options }]),
  ).toThrow('imported HTML');
});

it('keeps XML-RPC articles visible when the connected Editor cannot read another author’s profile', async () => {
  const wp = new WordPressProvider({
    fetchImpl: async (_url, options) => ({
      status: 200,
      headers: {},
      url: site,
      body: Buffer.from(
        String(options?.body).includes('wp.getUser') ? fault(401) : responseXml([xp]),
      ),
    }),
  });
  expect((await wp.listPublishedPosts(xml, query)).items[0]!.options).toMatchObject({
    remote: { author: '' },
  });
});
