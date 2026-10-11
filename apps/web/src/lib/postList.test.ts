import { describe, expect, it } from 'vitest';
import type { PostView } from '@meegrow-social/contracts';
import {
  VIEW_STORAGE_KEY,
  appendPage,
  captionSnippet,
  mayHaveMore,
  readViewMode,
  safeExternalUrl,
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
    expect(mayHaveMore(50, 50)).toBe(true);
    expect(mayHaveMore(49, 50)).toBe(false);
    expect(mayHaveMore(0, 50)).toBe(false);
    expect(mayHaveMore(100, 100)).toBe(true);
  });

  it('appends a page without repeating rows that shifted between pages', () => {
    const a = post({ id: 'a' });
    const b = post({ id: 'b' });
    const c = post({ id: 'c' });
    expect(appendPage([a, b], [b, c]).map((p) => p.id)).toEqual(['a', 'b', 'c']);
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

describe('safeExternalUrl', () => {
  it('rejects non-http(s) URLs', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,hi')).toBeNull();
    expect(safeExternalUrl('not a url')).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl('http://example.com/a')).toBe('http://example.com/a');
    expect(safeExternalUrl('https://x.com/p/1')).toBe('https://x.com/p/1');
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
