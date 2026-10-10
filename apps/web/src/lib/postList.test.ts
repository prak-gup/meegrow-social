import { describe, expect, it } from 'vitest';
import type { PostView } from '@meegrow-social/contracts';
import {
  NO_FILTERS,
  PAGE_SIZE,
  VIEW_STORAGE_KEY,
  appendPage,
  captionSnippet,
  hasActiveFilters,
  matchesFilters,
  mayHaveMore,
  postActions,
  readViewMode,
  replacePost,
  safeExternalUrl,
  whenLabel,
  writeViewMode,
} from './postList';

const post = (over: Partial<PostView> = {}): PostView => ({
  id: '00000000-0000-4000-8000-000000000001',
  groupId: '00000000-0000-4000-8000-0000000000aa',
  provider: 'facebook',
  connectionId: '00000000-0000-4000-8000-0000000000bb',
  status: 'scheduled',
  caption: 'Hello',
  options: null,
  publishAt: new Date('2026-06-01T10:00:00Z'),
  releaseUrl: null,
  error: null,
  queueId: null,
  createdAt: new Date('2026-05-01T10:00:00Z'),
  ...over,
});

describe('pagination', () => {
  it('may have more only when the page was full', () => {
    expect(mayHaveMore(PAGE_SIZE)).toBe(true);
    expect(mayHaveMore(PAGE_SIZE - 1)).toBe(false);
    expect(mayHaveMore(0)).toBe(false);
    expect(mayHaveMore(100, 100)).toBe(true);
  });

  it('appends a page without repeating rows that shifted between pages', () => {
    const a = post({ id: 'a' });
    const b = post({ id: 'b' });
    const c = post({ id: 'c' });
    expect(appendPage([a, b], [b, c]).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('local list updates', () => {
  it('replaces a post in place', () => {
    const a = post({ id: 'a' });
    const b = post({ id: 'b', caption: 'old' });
    const next = replacePost([a, b], { ...b, caption: 'new' });
    expect(next.map((p) => p.caption)).toEqual(['Hello', 'new']);
  });

  it('matches posts against the active filters', () => {
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
    expect(hasActiveFilters({ status: '', provider: 'x' })).toBe(true);
    expect(matchesFilters(post({ status: 'cancelled' }), NO_FILTERS)).toBe(true);
    expect(
      matchesFilters(post({ status: 'cancelled' }), { status: 'scheduled', provider: '' }),
    ).toBe(false);
    expect(matchesFilters(post(), { status: 'scheduled', provider: 'instagram' })).toBe(false);
    expect(matchesFilters(post(), { status: 'scheduled', provider: 'facebook' })).toBe(true);
  });
});

describe('whenLabel', () => {
  it('has no date line for drafts', () => {
    expect(whenLabel(post({ status: 'draft', publishAt: null }))).toBeNull();
  });
  it('words the date by status', () => {
    expect(whenLabel(post({ status: 'scheduled' }))).toEqual({
      prefix: 'Scheduled for',
      showDate: true,
    });
    expect(whenLabel(post({ status: 'published' }))).toEqual({
      prefix: 'Published',
      showDate: true,
    });
    expect(whenLabel(post({ status: 'failed' }))).toEqual({
      prefix: 'Was scheduled for',
      showDate: true,
    });
    expect(whenLabel(post({ status: 'cancelled' }))).toEqual({
      prefix: 'Was scheduled for',
      showDate: true,
    });
  });
  it('treats a date-less scheduled post as "post now"', () => {
    expect(whenLabel(post({ status: 'scheduled', publishAt: null }))).toEqual({
      prefix: 'Sending as soon as possible',
      showDate: false,
    });
  });
  it('shows nothing for placeholder or missing dates on sent posts', () => {
    expect(whenLabel(post({ status: 'published', publishAt: new Date(0) }))).toBeNull();
    expect(whenLabel(post({ status: 'failed', publishAt: null }))).toBeNull();
  });
});

describe('captionSnippet', () => {
  it('flattens whitespace and truncates', () => {
    expect(captionSnippet('  a\n\n b   c ')).toBe('a b c');
    expect(captionSnippet('x'.repeat(60), 10)).toBe('xxxxxxxxx…');
  });
  it('names an empty caption', () => {
    expect(captionSnippet('  ')).toBe('no caption');
  });
});

describe('postActions', () => {
  it('offers edit and cancel only on draft and scheduled', () => {
    for (const status of ['draft', 'scheduled'] as const) {
      expect(postActions(post({ status }))).toMatchObject({ edit: true, cancel: true });
    }
    for (const status of ['publishing', 'published', 'failed', 'cancelled'] as const) {
      expect(postActions(post({ status }))).toMatchObject({ edit: false, cancel: false });
    }
  });
  it('offers the view link only for a safe release URL', () => {
    expect(
      postActions(post({ status: 'published', releaseUrl: 'https://x.com/p/1' })).viewUrl,
    ).toBe('https://x.com/p/1');
    expect(postActions(post({ status: 'published', releaseUrl: null })).viewUrl).toBeNull();
  });
  it('rejects non-http(s) URLs', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,hi')).toBeNull();
    expect(safeExternalUrl('not a url')).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
    expect(safeExternalUrl('http://example.com/a')).toBe('http://example.com/a');
  });
});

describe('view preference', () => {
  const memory = (initial?: string) => {
    const store = new Map<string, string>(initial ? [[VIEW_STORAGE_KEY, initial]] : []);
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  };
  const blocked = () => {
    throw new Error('SecurityError');
  };

  it('defaults to grid and ignores junk', () => {
    expect(readViewMode(() => memory())).toBe('grid');
    expect(readViewMode(() => memory('carousel'))).toBe('grid');
  });
  it('round-trips the choice', () => {
    const s = memory();
    writeViewMode('list', () => s);
    expect(readViewMode(() => s)).toBe('list');
  });
  it('works when storage is unavailable', () => {
    expect(readViewMode(blocked)).toBe('grid');
    expect(() => writeViewMode('list', blocked)).not.toThrow();
  });
});
