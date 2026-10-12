import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PostView } from '@meegrow-social/contracts';
import { RemoteArticleEditor } from '../components/RemoteArticleEditor';
const post = {
  id: 'post',
  provider: 'wordpress',
  status: 'published',
  caption: '<script>alert("x")</script><p>body</p>',
  platformRemovedAt: null,
  options: {
    kind: 'wordpress',
    title: 'Title',
    remote: {
      title: 'Title',
      excerpt: '',
      slug: 'title',
      status: 'draft',
      modifiedAt: '2026-10-10T11:00:00.000Z',
      publishedAt: null,
      categories: [],
      tags: [],
      categoryIds: [],
      tagIds: [],
      featuredMediaId: 0,
      author: '',
      bodyFormat: 'html',
      bodyTruncated: false,
    },
  },
} as PostView;
const render = (p: PostView) =>
  renderToStaticMarkup(createElement(RemoteArticleEditor, { post: p, onChange: () => {} }));
describe('remote article editor markup', () => {
  it('labels HTML accurately and escapes source without executing it', () => {
    const html = render(post);
    expect(html).toContain('HTML source from WordPress');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Save on site');
    expect(html).toContain('Move to trash on site');
  });
  it('opens in reading mode with a read-only advanced source and does not load the editor', () => {
    const html = render(post);
    expect(html).toMatch(/<fieldset[^>]*hidden=""/);
    expect(html).toMatch(/<textarea[^>]*readonly=""/);
    expect(html).not.toContain('Article rich text editor');
  });
  it('disables editing before a site version has been observed', () => {
    const html = render({ ...post, options: { kind: 'wordpress', title: 'Title' } });
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain('Refresh from site to load');
  });
  it('disables truncated body edits with an explanation', () => {
    const html = render({
      ...post,
      options: {
        ...post.options,
        remote: {
          ...(post.options?.kind === 'wordpress' ? post.options.remote : {}),
          bodyTruncated: true,
        },
      },
    } as PostView);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain('stored copy is truncated');
  });
  it('disables writes for removed articles', () => {
    expect(render({ ...post, platformRemovedAt: new Date() })).toMatch(/<fieldset[^>]*disabled=""/);
  });
});
