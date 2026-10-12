import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PublishingNext } from './Overview';
vi.stubGlobal('React', React);

describe('Publishing next', () => {
  it('renders one row per group with caption, all badges, account tooltips and later count', () => {
    const html = renderToStaticMarkup(
      React.createElement(PublishingNext, {
        groups: [
          {
            groupId: 'group',
            workspaceId: 'ws',
            workspaceName: 'Acme',
            caption: 'One shared post',
            publishAt: new Date('2026-10-13T09:00:00Z'),
            laterCount: 1,
            accounts: [
              { connectionId: 'fb', provider: 'facebook', name: 'Acme Page' },
              { connectionId: 'ig', provider: 'instagram', name: 'Acme Photos' },
            ],
          },
        ],
      }),
    );
    expect(html.match(/One shared post/g)).toHaveLength(1);
    expect(html).toContain('title="Acme Page (facebook)"');
    expect(html).toContain('title="Acme Photos (instagram)"');
    expect(html).toContain('Facebook');
    expect(html).toContain('Instagram');
    expect(html).toContain('+1 later');
  });

  it('omits the table when no groups are scheduled and later text for simultaneous delivery', () => {
    expect(renderToStaticMarkup(React.createElement(PublishingNext, { groups: [] }))).toBe('');
    const html = renderToStaticMarkup(
      React.createElement(PublishingNext, {
        groups: [
          {
            groupId: 'group',
            workspaceId: 'ws',
            workspaceName: 'Acme',
            caption: 'Article title',
            publishAt: new Date('2026-10-13T09:00:00Z'),
            laterCount: 0,
            accounts: [{ connectionId: 'wp', provider: 'wordpress', name: 'Acme Blog' }],
          },
        ],
      }),
    );
    expect(html).toContain('Article title');
    expect(html).not.toContain(' later');
  });
});
