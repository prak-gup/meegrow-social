import { describe, it, expect, vi } from 'vitest';
import { ARTICLE_BODY_MAX } from '@meegrow-social/contracts';
import { WordPressProvider } from './wordpress.js';
import { encodeCredentials } from './client.js';
import { encodeMethodCall, type XmlRpcValue } from './xmlrpc.js';

// Documentation-built WordPress REST posts and wp.getPost responses. No live network.
const site = 'https://blog.example.test';
const expected = '2026-10-10T11:00:00.000Z';
const restPost = {
  id: 12,
  title: { raw: 'Title' },
  content: { raw: '<p>Body</p>' },
  excerpt: { raw: 'Summary' },
  slug: 'title',
  status: 'draft',
  modified_gmt: '2026-10-10T11:00:00',
  date_gmt: null,
  categories: [],
  tags: [],
  featured_media: 0,
  link: `${site}/?p=12`,
};
const xmlPost = {
  post_id: '12',
  post_title: 'Title',
  post_content: '<p>Body</p>',
  post_excerpt: 'Summary',
  post_name: 'title',
  post_status: 'draft',
  post_modified_gmt: '20261010T11:00:00',
  post_date_gmt: '20261010T10:00:00',
  terms: [],
  link: `${site}/?p=12`,
};
const xmlResponse = (value: XmlRpcValue) =>
  encodeMethodCall('fixture', [value])
    .replace(/<methodCall><methodName>fixture<\/methodName>/, '<methodResponse>')
    .replace('</methodCall>', '</methodResponse>');
function fixture(transport: 'rest' | 'xmlrpc', responses: unknown[]) {
  const fetchImpl = vi.fn(async () => {
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return {
      status: 200,
      headers: {},
      url: site,
      body: Buffer.from(
        transport === 'rest' ? JSON.stringify(value) : xmlResponse(value as XmlRpcValue),
      ),
    };
  });
  const tokens = {
    accessToken: encodeCredentials(
      transport === 'rest'
        ? { siteUrl: site, apiRoot: `${site}/wp-json/`, username: 'editor', password: 'secret' }
        : {
            transport,
            siteUrl: site,
            endpoint: `${site}/xmlrpc.php`,
            username: 'editor',
            password: 'secret',
          },
    ),
    externalId: site,
    displayName: 'Blog',
  };
  return { wp: new WordPressProvider({ fetchImpl }), fetchImpl, tokens };
}
describe.each(['rest', 'xmlrpc'] as const)('%s remote article edits', (transport) => {
  const before = transport === 'rest' ? restPost : xmlPost;
  const changed = (patch: Record<string, unknown>) => ({ ...before, ...patch });
  it('reads a single article with HTML, version and numeric site identifiers', async () => {
    const { wp, tokens } = fixture(transport, [before]);
    expect(await wp.readPublishedPost(tokens, '12')).toMatchObject({
      externalPostId: '12',
      caption: '<p>Body</p>',
      options: {
        remote: {
          modifiedAt: expected,
          bodyFormat: 'html',
          categoryIds: [],
          tagIds: [],
          featuredMediaId: 0,
        },
      },
    });
  });
  it('writes only requested fields and independently reads them back', async () => {
    const after = changed(transport === 'rest' ? { title: { raw: 'New' } } : { post_title: 'New' });
    const { wp, tokens, fetchImpl } = fixture(transport, [
      before,
      transport === 'rest' ? after : true,
      after,
    ]);
    expect(
      (await wp.updatePublishedPost(tokens, '12', expected, { title: 'New' }, 'html')).options,
    ).toMatchObject({ remote: { title: 'New' } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const request = fetchImpl.mock.calls[1] as unknown as [
      string,
      { body: string; method: string },
    ];
    expect(request[1].method).toBe('POST');
    expect(request[1].body).toContain(
      transport === 'rest' ? '"title":"New"' : '<methodName>wp.editPost</methodName>',
    );
    expect(request[1].body).not.toContain(transport === 'rest' ? 'content' : 'post_content');
  });
  it('verifies excerpt, slug, status, term IDs and featured image removals', async () => {
    const fields = {
      excerpt: 'New summary',
      slug: 'new-slug',
      status: 'private' as const,
      categories: [3],
      tags: [4],
      featuredImage: 0,
    };
    const after = changed(
      transport === 'rest'
        ? {
            excerpt: { raw: 'New summary' },
            slug: 'new-slug',
            status: 'private',
            categories: [3],
            tags: [4],
            _embedded: {
              'wp:term': [
                [{ id: 3, taxonomy: 'category', name: 'News' }],
                [{ id: 4, taxonomy: 'post_tag', name: 'Guide' }],
              ],
            },
          }
        : {
            post_excerpt: 'New summary',
            post_name: 'new-slug',
            post_status: 'private',
            terms: [
              { term_id: '3', taxonomy: 'category', name: 'News' },
              { term_id: '4', taxonomy: 'post_tag', name: 'Guide' },
            ],
          },
    );
    const { wp, tokens, fetchImpl } = fixture(transport, [
      before,
      transport === 'rest' ? after : true,
      after,
    ]);
    expect(
      (await wp.updatePublishedPost(tokens, '12', expected, fields, 'html')).options,
    ).toMatchObject({
      remote: {
        excerpt: 'New summary',
        slug: 'new-slug',
        status: 'private',
        categoryIds: [3],
        tagIds: [4],
        featuredMediaId: 0,
      },
    });
    const request = fetchImpl.mock.calls[1] as unknown as [string, { body: string }];
    expect(request[1].body).toContain(
      transport === 'rest' ? '"featured_media":0' : '<name>post_thumbnail</name>',
    );
  });
  it('reports an unconfirmed write when the independent read-back fails', async () => {
    const { wp, tokens } = fixture(transport, [
      before,
      transport === 'rest' ? {} : true,
      new Error('fixture read failure'),
    ]);
    await expect(
      wp.updatePublishedPost(tokens, '12', expected, { title: 'New' }, 'html'),
    ).rejects.toThrow('change may have been applied');
  });
  it('refuses changed-site versions before any mutation', async () => {
    const { wp, tokens, fetchImpl } = fixture(transport, [before]);
    await expect(
      wp.updatePublishedPost(tokens, '12', '2026-10-09T11:00:00.000Z', { title: 'New' }, 'html'),
    ).rejects.toThrow('changed on the site — refresh');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('never trusts a write response without independent read-back', async () => {
    const { wp, tokens } = fixture(transport, [
      before,
      transport === 'rest' ? changed({ title: { raw: 'New' } }) : true,
      before,
    ]);
    await expect(
      wp.updatePublishedPost(tokens, '12', expected, { title: 'New' }, 'html'),
    ).rejects.toThrow('did not store the requested title');
  });
  it('preserves imported HTML without Markdown round-trip', async () => {
    const body = '<div class="wp-block"><p>**literal** &amp; text</p></div>';
    const after = changed(
      transport === 'rest' ? { content: { raw: body } } : { post_content: body },
    );
    const { wp, tokens, fetchImpl } = fixture(transport, [
      before,
      transport === 'rest' ? after : true,
      after,
    ]);
    await wp.updatePublishedPost(tokens, '12', expected, { body }, 'html');
    const request = fetchImpl.mock.calls[1] as unknown as [string, { body: string }];
    expect(request[1].body).not.toContain('<strong>');
    expect(request[1].body).toContain('literal');
  });
  it('converts app-authored Markdown through the existing converter', async () => {
    const after = changed(
      transport === 'rest'
        ? { content: { raw: '<p><strong>new</strong></p>' } }
        : { post_content: '<p><strong>new</strong></p>' },
    );
    const { wp, tokens } = fixture(transport, [before, transport === 'rest' ? after : true, after]);
    expect(
      (await wp.updatePublishedPost(tokens, '12', expected, { body: '**new**' }, 'markdown'))
        .caption,
    ).toBe('<p><strong>new</strong></p>');
  });
  it('refuses truncated bodies before writing', async () => {
    const body = 'a'.repeat(ARTICLE_BODY_MAX + 1);
    const { wp, tokens, fetchImpl } = fixture(transport, [
      changed(transport === 'rest' ? { content: { raw: body } } : { post_content: body }),
    ]);
    await expect(
      wp.updatePublishedPost(tokens, '12', expected, { body: 'short' }, 'html'),
    ).rejects.toThrow('truncated');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('trashes once and requires an independent trash observation', async () => {
    const after = changed(transport === 'rest' ? { status: 'trash' } : { post_status: 'trash' });
    const { wp, tokens, fetchImpl } = fixture(transport, [
      before,
      transport === 'rest' ? after : true,
      after,
    ]);
    await wp.deletePublishedPost(tokens, '12', expected);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const request = fetchImpl.mock.calls[1] as unknown as [
      string,
      { method: string; body: string },
    ];
    if (transport === 'rest') {
      expect(request[0]).toContain('force=false');
      expect(request[1].method).toBe('DELETE');
    } else {
      expect(request[1].body).toContain('wp.editPost');
      expect(request[1].body).toContain('trash');
      expect(request[1].body).not.toContain('wp.deletePost');
    }
  });
  it('does not claim trash when the read-back is still live', async () => {
    const { wp, tokens } = fixture(transport, [before, transport === 'rest' ? {} : true, before]);
    await expect(wp.deletePublishedPost(tokens, '12', expected)).rejects.toThrow(
      'trash was not confirmed',
    );
  });
  it('refuses trash conflicts without issuing a mutation', async () => {
    const { wp, tokens, fetchImpl } = fixture(transport, [before]);
    await expect(wp.deletePublishedPost(tokens, '12', '2026-10-09T11:00:00.000Z')).rejects.toThrow(
      'changed on the site',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rejects non-numeric IDs before making any request', async () => {
    const { wp, tokens, fetchImpl } = fixture(transport, []);
    await expect(wp.readPublishedPost(tokens, '../users')).rejects.toThrow('Invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
