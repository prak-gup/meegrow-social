import { describe, expect, it } from 'vitest';
import {
  ARTICLE_BODY_MAX,
  CAPTION_MAX,
  captionLimitForProvider,
  createPostInput,
  postOptions,
  updatePostInput,
} from './posts.js';
import type { ProviderIdentifier } from './providers.js';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const MEDIA_ID = '22222222-2222-4222-8222-222222222222';

const video = { mediaId: MEDIA_ID, kind: 'video' as const, url: 'https://cdn.test/v.mp4' };

/** A create-post body with a single variant — the unit under test for per-platform options (#44). */
function input(provider: ProviderIdentifier, options?: unknown, media = [video]) {
  return {
    caption: 'hello',
    media,
    variants: [{ connectionId: CONNECTION_ID, provider, ...(options ? { options } : {}) }],
  };
}

describe('postOptions discriminated union', () => {
  it('applies youtube defaults so the provider never sees undefined', () => {
    const parsed = postOptions.parse({ kind: 'youtube', title: 'Launch film' });
    expect(parsed).toMatchObject({
      kind: 'youtube',
      title: 'Launch film',
      privacyStatus: 'public',
      madeForKids: false,
    });
  });

  it('applies the gmb topicType default', () => {
    expect(postOptions.parse({ kind: 'gmb' })).toMatchObject({ topicType: 'STANDARD' });
  });

  it('applies the meta format default', () => {
    expect(postOptions.parse({ kind: 'meta' })).toMatchObject({ format: 'feed' });
  });

  it('rejects an unknown kind', () => {
    expect(postOptions.safeParse({ kind: 'tiktok' }).success).toBe(false);
  });
});

describe('youtube variants require options', () => {
  it('rejects a youtube variant with no options at all', () => {
    // The whole point of #44: this must fail at CREATE time, not at 3am when the job runs.
    expect(createPostInput.safeParse(input('youtube')).success).toBe(false);
  });

  it('rejects youtube options with no title', () => {
    expect(createPostInput.safeParse(input('youtube', { kind: 'youtube' })).success).toBe(false);
  });

  it('rejects an empty youtube title', () => {
    const r = createPostInput.safeParse(input('youtube', { kind: 'youtube', title: '' }));
    expect(r.success).toBe(false);
  });

  it('rejects a youtube title over 100 characters', () => {
    const r = createPostInput.safeParse(
      input('youtube', { kind: 'youtube', title: 'x'.repeat(101) }),
    );
    expect(r.success).toBe(false);
  });

  it('accepts a youtube variant carrying a title', () => {
    const r = createPostInput.safeParse(
      input('youtube', { kind: 'youtube', title: 'Launch film' }),
    );
    expect(r.success).toBe(true);
  });
});

describe('the options arm must match the variant provider', () => {
  it('rejects youtube options on a gmb variant', () => {
    const r = createPostInput.safeParse(input('gmb', { kind: 'youtube', title: 'wrong' }));
    expect(r.success).toBe(false);
  });

  it('rejects gmb options on an instagram variant', () => {
    const r = createPostInput.safeParse(input('instagram', { kind: 'gmb' }));
    expect(r.success).toBe(false);
  });

  it('accepts meta options on instagram and facebook — they share one arm', () => {
    for (const p of ['instagram', 'facebook'] as const) {
      const r = createPostInput.safeParse(input(p, { kind: 'meta', format: 'reel' }));
      expect(r.success, p).toBe(true);
    }
  });

  it('accepts gmb options on a gmb variant', () => {
    const r = createPostInput.safeParse(input('gmb', { kind: 'gmb', topicType: 'EVENT' }));
    expect(r.success).toBe(true);
  });
});

describe('backwards compatibility', () => {
  it('accepts every non-youtube provider with no options — existing callers keep working', () => {
    for (const p of ['instagram', 'facebook', 'gmb', 'linkedin', 'fake'] as const) {
      const r = createPostInput.safeParse(input(p));
      expect(r.success, p).toBe(true);
    }
  });

  it('leaves options undefined when not supplied', () => {
    const r = createPostInput.parse(input('fake'));
    expect(r.variants[0]!.options).toBeUndefined();
  });
});

describe('updatePostInput', () => {
  it('accepts an options patch so a draft can be re-targeted', () => {
    const r = updatePostInput.safeParse({ options: { kind: 'youtube', title: 'Renamed' } });
    expect(r.success).toBe(true);
  });

  it('still accepts a patch with no options', () => {
    expect(updatePostInput.safeParse({ caption: 'edited' }).success).toBe(true);
  });
});

describe('wordpress articles', () => {
  const text = (provider: ProviderIdentifier, variant: object = {}, caption = 'hello') => ({
    caption,
    variants: [{ connectionId: CONNECTION_ID, provider, ...variant }],
  });
  const options = { kind: 'wordpress', title: 'Five ways to cut plastic' };

  it('defaults the WordPress status to publish and trims the title', () => {
    expect(postOptions.parse({ kind: 'wordpress', title: '  A title  ' })).toEqual({
      kind: 'wordpress',
      title: 'A title',
      status: 'publish',
    });
  });

  it('requires options, because the title lives there', () => {
    const result = createPostInput.safeParse(text('wordpress'));
    expect(result.success).toBe(false);
    expect(createPostInput.safeParse(text('wordpress', { options })).success).toBe(true);
  });

  it.each([
    ['no title', { kind: 'wordpress' }],
    ['a blank title', { kind: 'wordpress', title: '   ' }],
    ['a title past 300 characters', { kind: 'wordpress', title: 'a'.repeat(301) }],
    ['WordPress’s own scheduling status', { ...options, status: 'future' }],
    ['an unknown status', { ...options, status: 'trash' }],
    ['a slug with spaces', { ...options, slug: 'Cut Plastic' }],
    ['a slug with a path', { ...options, slug: '../wp-admin' }],
    ['a slug with a trailing hyphen', { ...options, slug: 'cut-plastic-' }],
    ['a zero category id', { ...options, categories: [0] }],
    ['an empty tag name', { ...options, tags: [''] }],
    [
      'more than 20 categories',
      { ...options, categories: Array.from({ length: 21 }, (_, i) => i + 1) },
    ],
  ])('rejects %s', (_name, bad) => {
    expect(postOptions.safeParse(bad).success).toBe(false);
  });

  it('accepts the article fields, with terms by id or by name', () => {
    const parsed = postOptions.parse({
      ...options,
      excerpt: 'Five small changes.',
      slug: 'cut-plastic-2026',
      categories: [4, 'Sustainability'],
      tags: ['plastic', 21],
      status: 'draft',
    });
    expect(parsed).toMatchObject({ categories: [4, 'Sustainability'], status: 'draft' });
  });

  it('rejects another platform’s options on a wordpress variant, and the reverse', () => {
    expect(
      createPostInput.safeParse(text('wordpress', { options: { kind: 'meta' } })).success,
    ).toBe(false);
    expect(createPostInput.safeParse(text('instagram', { options })).success).toBe(false);
  });

  it('lets an article body run to ARTICLE_BODY_MAX in the variant’s own caption', () => {
    const at = (n: number) => text('wordpress', { options, caption: 'a'.repeat(n) }, '');
    expect(createPostInput.safeParse(at(CAPTION_MAX + 1)).success).toBe(true);
    expect(createPostInput.safeParse(at(ARTICLE_BODY_MAX)).success).toBe(true);
    expect(createPostInput.safeParse(at(ARTICLE_BODY_MAX + 1)).success).toBe(false);
  });

  it('keeps every other provider’s variant caption at CAPTION_MAX', () => {
    for (const provider of ['instagram', 'facebook', 'gmb', 'fake'] as const) {
      const at = (n: number) => text(provider, { caption: 'a'.repeat(n) });
      expect(createPostInput.safeParse(at(CAPTION_MAX)).success).toBe(true);
      const over = createPostInput.safeParse(at(CAPTION_MAX + 1));
      expect(over.success).toBe(false);
      if (!over.success) expect(over.error.issues[0]!.path).toEqual(['variants', 0, 'caption']);
    }
  });

  it('keeps the shared group caption at CAPTION_MAX whoever inherits it', () => {
    expect(
      createPostInput.safeParse(text('wordpress', { options }, 'a'.repeat(CAPTION_MAX + 1)))
        .success,
    ).toBe(false);
  });

  it('says how long a caption each provider takes', () => {
    expect(captionLimitForProvider('wordpress')).toBe(ARTICLE_BODY_MAX);
    expect(captionLimitForProvider('instagram')).toBe(CAPTION_MAX);
  });

  it('bounds an edit at the article limit; the provider’s own limit is applied by updatePost', () => {
    expect(updatePostInput.safeParse({ caption: 'a'.repeat(ARTICLE_BODY_MAX) }).success).toBe(true);
    expect(updatePostInput.safeParse({ caption: 'a'.repeat(ARTICLE_BODY_MAX + 1) }).success).toBe(
      false,
    );
  });
});
