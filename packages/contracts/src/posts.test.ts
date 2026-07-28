import { describe, expect, it } from 'vitest';
import { createPostInput, postOptions, updatePostInput } from './posts.js';
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
