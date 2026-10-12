import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { PostView } from '@meegrow-social/contracts';
import { WordPressArticleMeta } from '../components/WordPressArticleMeta';

const post = {
  id: 'article-id',
  provider: 'wordpress',
  status: 'published',
  source: 'imported',
  releaseUrl: 'https://example.test/article',
  options: { kind: 'wordpress', title: 'Article', status: 'draft' },
} as PostView;

function render(p: PostView, link = true) {
  return renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location: '/content' },
      createElement(WordPressArticleMeta, { posts: [p], link }),
    ),
  );
}

describe('Content article links', () => {
  it('links imported and app-published article cards to their own Blog detail', () => {
    for (const source of ['app', 'imported'] as const) {
      const html = render({ ...post, source });
      expect(html).toContain('href="/blog/article-id"');
      expect(html).toContain('Article details');
      expect(html).toContain('href="https://example.test/article"');
      expect(html).toContain('rel="noopener noreferrer"');
    }
  });
  it('does not send unsent drafts to the site inventory', () => {
    expect(render({ ...post, status: 'draft', releaseUrl: null })).not.toContain('/blog/');
  });
  it('keeps compact contexts link-free and refuses executable site URLs', () => {
    expect(render(post, false)).not.toContain('href=');
    const html = render({ ...post, releaseUrl: 'javascript:alert(1)' });
    expect(html).toContain('/blog/article-id');
    expect(html).not.toContain('javascript:');
  });
});
