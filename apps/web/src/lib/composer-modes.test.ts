import { describe, expect, it } from 'vitest';
import type { ConnectionView, PostValidationIssue } from '@meegrow-social/contracts';
import {
  initialContentMode,
  modeConnections,
  switchContentMode,
  visibleAccountProblems,
  buildCreatePostInput,
  type ComposerForm,
} from './composer';
import { emptyArticle } from './wordpress';

const connections = [
  { id: 'social', provider: 'telegram', needsReconnect: false, health: 'ok' },
  { id: 'site', provider: 'wordpress', needsReconnect: false, health: 'ok' },
] as ConnectionView[];
const issue: PostValidationIssue = {
  connectionId: 'social',
  provider: 'telegram',
  code: 'not_publishable',
  message: 'A Telegram post needs text, a photo or a video',
};

describe('composer modes', () => {
  it('defaults to Post, but Blog and WordPress drafts/duplicates use Article', () => {
    expect(initialContentMode('/content')).toBe('post');
    expect(initialContentMode('/blog?status=draft')).toBe('article');
    expect(initialContentMode('/blog/site')).toBe('article');
    expect(initialContentMode('/content', [{ provider: 'wordpress' }])).toBe('article');
    expect(initialContentMode('/blogger')).toBe('post');
  });
  it('lists mutually exclusive accounts, including no Article accounts without a connection', () => {
    expect(modeConnections(connections, 'post').map((c) => c.id)).toEqual(['social']);
    expect(modeConnections(connections, 'article').map((c) => c.id)).toEqual(['site']);
    expect(modeConnections(connections.slice(0, 1), 'article')).toEqual([]);
  });
  it('restores independent selections without touching shared text or article fields', () => {
    const original = {
      contentMode: 'article' as const,
      selections: { post: ['social'], article: ['site'] },
      caption: 'a'.repeat(6000),
      article: { ...emptyArticle(), title: 'Saved title' },
    };
    const post = switchContentMode(original, 'post');
    expect(post).toEqual({ ...original, contentMode: 'post' });
    expect(switchContentMode(post, 'article')).toEqual(original);
    const form: ComposerForm = {
      caption: original.caption,
      article: original.article,
      media: [],
      connectionIds: post.selections.post,
      mode: 'draft',
      at: '',
      queueId: '',
    };
    expect(
      buildCreatePostInput(form, modeConnections(connections, 'post')).variants.map(
        (v) => v.provider,
      ),
    ).toEqual(['telegram']);
  });
});

describe('visible account problems', () => {
  it('never flags unselected accounts, even on submit or reconnect', () => {
    expect(
      visibleAccountProblems(
        [{ ...connections[0]!, needsReconnect: true }],
        [issue],
        [],
        true,
        true,
      ).size,
    ).toBe(0);
  });
  it('hides requirements while empty and exposes them after typing or submit', () => {
    expect(visibleAccountProblems(connections, [issue], ['social'], false, false).size).toBe(0);
    expect(
      visibleAccountProblems(connections, [issue], ['social'], true, false).get('social')?.reason,
    ).toBe(issue.message);
    expect(visibleAccountProblems(connections, [issue], ['social'], false, true).size).toBe(1);
  });
  it('only counts selected issues, and shows selected reconnect problems immediately', () => {
    expect(visibleAccountProblems(connections, [issue], ['site'], true, true).size).toBe(0);
    expect(
      visibleAccountProblems(
        [{ ...connections[0]!, needsReconnect: true }],
        [],
        ['social'],
        false,
        false,
      ).get('social')?.kind,
    ).toBe('reconnect');
  });
});
