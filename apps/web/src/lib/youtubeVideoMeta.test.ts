import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PostView } from '@meegrow-social/contracts';
import { YouTubeVideoMeta } from '../components/YouTubeVideoMeta';
vi.stubGlobal('React', React);

// Documentation-built fixture; no real account, credentials, or Google response.
const post = {
  provider: 'youtube',
  status: 'published',
  releaseUrl: 'https://www.youtube.com/watch?v=fixture-video',
  options: {
    kind: 'youtube',
    title: 'Example video',
    privacyStatus: 'public',
    madeForKids: false,
    durationSeconds: 65,
    shortsHint: true,
    remote: { privacyStatus: 'private' },
  },
} as PostView;
const render = (p: PostView, link = true) =>
  renderToStaticMarkup(React.createElement(YouTubeVideoMeta, { posts: [p], link }));
describe('YouTube content facts', () => {
  it('shows confirmed visibility rather than requested visibility, duration, and safe link', () => {
    const html = render(post);
    expect(html).toContain('Private');
    expect(html).not.toContain('Requested public');
    expect(html).toContain('1:05');
    expect(html).toContain('Shorts tag');
    expect(html).toContain('View on YouTube');
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it('does not pretend a published upload has confirmed visibility without a read-back', () => {
    expect(
      render({
        ...post,
        options: { kind: 'youtube', title: 'Example', privacyStatus: 'public', madeForKids: false },
      }),
    ).toContain('Visibility unconfirmed');
  });
  it('keeps nested calendar buttons link-free and refuses unsafe URLs', () => {
    expect(render(post, false)).not.toContain('href=');
    expect(render({ ...post, releaseUrl: 'javascript:alert(1)' })).not.toContain('href=');
  });
  it('does not add YouTube facts to another platform', () => {
    expect(render({ ...post, provider: 'instagram' })).toBe('');
  });
});
