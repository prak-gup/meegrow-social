import { describe, expect, it } from 'vitest';
import {
  ARTICLE_BODY_MAX as CONTRACT_BODY_MAX,
  CAPTION_MAX as CONTRACT_CAPTION_MAX,
  createPostInput,
  postOptions,
} from '@meegrow-social/contracts';
import type { ConnectionView, MediaRef, QueueView } from '@meegrow-social/contracts';
import {
  CAPTION_MAX,
  buildCreatePostInput,
  buildValidationInput,
  captionRole,
  featuredImage,
  hasErrors,
  isDirty,
  validateForm,
  type ComposerForm,
} from './composer';
import { dayEntries, groupCaption } from './postGroups';
import {
  ARTICLE_BODY_MAX,
  ARTICLE_CATEGORIES_MAX,
  ARTICLE_EXCERPT_MAX,
  ARTICLE_SLUG_MAX,
  ARTICLE_TAGS_MAX,
  ARTICLE_TITLE_MAX,
  articleDirty,
  articleOptions,
  emptyArticle,
  isArticleProvider,
  parseTerms,
  postHeadline,
  siteAddressProblem,
  slugify,
  validateArticle,
  type ArticleForm,
} from './wordpress';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const conn = (n: number, provider: ConnectionView['provider']): ConnectionView => ({
  id: id(n),
  provider,
  externalId: provider === 'wordpress' ? 'https://blog.example.com' : `ext-${n}`,
  displayName: `Account ${n}`,
  needsReconnect: false,
  expiresAt: null,
  expiresInDays: null,
  health: 'healthy',
  createdAt: new Date('2026-01-01T00:00:00Z'),
});

const FB = conn(1, 'facebook');
const IG = conn(2, 'instagram');
const WP = conn(3, 'wordpress');
const WP2 = conn(4, 'wordpress');
const conns = [FB, IG, WP, WP2];
const queues: QueueView[] = [];
const NOW = new Date(2026, 9, 10, 12, 0, 0);

const article = (over: Partial<ArticleForm> = {}): ArticleForm => ({
  ...emptyArticle(),
  title: 'Five ways to cut plastic',
  ...over,
});

const form = (over: Partial<ComposerForm> = {}): ComposerForm => ({
  caption: '# Why\n\nBecause plastic lasts.',
  media: [],
  connectionIds: [WP.id],
  mode: 'draft',
  at: '',
  queueId: '',
  article: article(),
  ...over,
});

const image = (n: number): MediaRef => ({ mediaId: id(100 + n), kind: 'image' });
const video = (n: number): MediaRef => ({ mediaId: id(200 + n), kind: 'video' });

describe('limits mirror the contract', () => {
  it('body and caption limits are the contract’s own', () => {
    expect(ARTICLE_BODY_MAX).toBe(CONTRACT_BODY_MAX);
    expect(CAPTION_MAX).toBe(CONTRACT_CAPTION_MAX);
  });

  const options = (over: object) =>
    postOptions.safeParse({ kind: 'wordpress', title: 'T', ...over });

  it('title, excerpt and slug limits are the largest the contract accepts', () => {
    expect(options({ title: 'a'.repeat(ARTICLE_TITLE_MAX) }).success).toBe(true);
    expect(options({ title: 'a'.repeat(ARTICLE_TITLE_MAX + 1) }).success).toBe(false);
    expect(options({ excerpt: 'a'.repeat(ARTICLE_EXCERPT_MAX) }).success).toBe(true);
    expect(options({ excerpt: 'a'.repeat(ARTICLE_EXCERPT_MAX + 1) }).success).toBe(false);
    expect(options({ slug: 'a'.repeat(ARTICLE_SLUG_MAX) }).success).toBe(true);
    expect(options({ slug: 'a'.repeat(ARTICLE_SLUG_MAX + 1) }).success).toBe(false);
  });

  it('term counts are the largest the contract accepts', () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    expect(options({ categories: names(ARTICLE_CATEGORIES_MAX) }).success).toBe(true);
    expect(options({ categories: names(ARTICLE_CATEGORIES_MAX + 1) }).success).toBe(false);
    expect(options({ tags: names(ARTICLE_TAGS_MAX) }).success).toBe(true);
    expect(options({ tags: names(ARTICLE_TAGS_MAX + 1) }).success).toBe(false);
  });
});

describe('parseTerms', () => {
  it('splits on commas, trims, and drops blanks and repeats whatever their case', () => {
    expect(parseTerms(' News,  Eco   tips ,news,, ,Guides')).toEqual([
      'News',
      'Eco tips',
      'Guides',
    ]);
    expect(parseTerms('')).toEqual([]);
    expect(parseTerms(' , ')).toEqual([]);
  });
});

describe('slugify', () => {
  it('makes what the contract accepts as a slug', () => {
    for (const title of ['Five Ways (2026)!', '  Crème brûlée — à la carte ', 'a--b__c', 'ÉCO']) {
      const slug = slugify(title);
      expect(postOptions.safeParse({ kind: 'wordpress', title: 'T', slug }).success).toBe(true);
    }
    expect(slugify('Five Ways (2026)!')).toBe('five-ways-2026');
    expect(slugify('Crème brûlée')).toBe('creme-brulee');
    expect(slugify('日本語')).toBe('');
    expect(slugify(`${'a'.repeat(199)}-b`)).toBe('a'.repeat(199));
  });
});

describe('validateArticle', () => {
  it('accepts a titled article with nothing else', () => {
    expect(validateArticle(article())).toEqual({});
  });

  it('requires a title, and counts it trimmed', () => {
    expect(validateArticle(article({ title: '' })).title).toBe('An article needs a title.');
    expect(validateArticle(article({ title: '   ' })).title).toBe('An article needs a title.');
    expect(validateArticle(article({ title: ` ${'a'.repeat(ARTICLE_TITLE_MAX)} ` }))).toEqual({});
    expect(validateArticle(article({ title: 'a'.repeat(ARTICLE_TITLE_MAX + 2) })).title).toContain(
      '2 over',
    );
  });

  it('rejects a slug the site would not keep, and suggests one', () => {
    expect(validateArticle(article({ slug: 'cut-plastic-2026' }))).toEqual({});
    expect(validateArticle(article({ slug: 'Cut Plastic!' })).slug).toContain('“cut-plastic”');
    expect(validateArticle(article({ slug: '../wp-admin' })).slug).toContain('“wp-admin”');
    expect(validateArticle(article({ slug: '日本' })).slug).toBe(
      'Use lowercase letters, numbers and single hyphens only.',
    );
  });

  it('limits the excerpt and the number and length of terms', () => {
    expect(
      validateArticle(article({ excerpt: 'a'.repeat(ARTICLE_EXCERPT_MAX + 1) })).excerpt,
    ).toContain('1 over');
    const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`).join(',');
    expect(validateArticle(article({ categories: many(ARTICLE_CATEGORIES_MAX) }))).toEqual({});
    expect(
      validateArticle(article({ categories: many(ARTICLE_CATEGORIES_MAX + 1) })).categories,
    ).toBe('At most 20 categories.');
    expect(validateArticle(article({ tags: many(ARTICLE_TAGS_MAX + 1) })).tags).toBe(
      'At most 50 tags.',
    );
    expect(validateArticle(article({ tags: 'a'.repeat(201) })).tags).toContain('200 characters');
  });
});

describe('articleOptions', () => {
  it('sends only what was filled in, in a shape the contract accepts unchanged', () => {
    expect(articleOptions(article({ title: '  Hello  ' }))).toEqual({
      kind: 'wordpress',
      title: 'Hello',
      status: 'publish',
    });
    const full = articleOptions(
      article({
        excerpt: ' Summary. ',
        slug: ' cut-plastic ',
        categories: 'News, Guides',
        tags: 'plastic,zero waste',
        status: 'draft',
      }),
    );
    expect(full).toEqual({
      kind: 'wordpress',
      title: 'Five ways to cut plastic',
      status: 'draft',
      excerpt: 'Summary.',
      slug: 'cut-plastic',
      categories: ['News', 'Guides'],
      tags: ['plastic', 'zero waste'],
    });
    expect(postOptions.parse(full)).toEqual(full);
  });
});

describe('captionRole — what the one text box is', () => {
  it('is a caption when no article account is selected', () => {
    expect(captionRole([FB, IG])).toMatchObject({ kind: 'caption', label: 'Caption', max: 5000 });
    expect(captionRole([])).toMatchObject({ kind: 'caption', hint: null });
  });

  it('is the article body, at article length, when only WordPress is selected', () => {
    const role = captionRole([WP, WP2]);
    expect(role).toMatchObject({ kind: 'article', label: 'Article body', max: 100_000 });
    expect(role.hint).toContain('Markdown');
  });

  it('is both, held to the caption limit, when WordPress is mixed with social accounts', () => {
    const role = captionRole([FB, WP]);
    expect(role).toMatchObject({ kind: 'both', max: 5000 });
    expect(role.hint).toContain('body of the WordPress article');
  });
});

describe('validateForm with an article account selected', () => {
  const validate = (f: ComposerForm) => validateForm(f, queues, NOW, conns);

  it('passes a titled article with a body', () => {
    expect(hasErrors(validate(form()))).toBe(false);
  });

  it('asks for a title and a body', () => {
    expect(validate(form({ article: article({ title: '' }) })).article?.title).toBe(
      'An article needs a title.',
    );
    expect(validate(form({ caption: '  \n ' })).caption).toBe('An article needs a body.');
    expect(validate(form({ article: undefined })).article?.title).toBeDefined();
  });

  it('asks nothing about the article when no article account is selected', () => {
    const errors = validate(
      form({
        connectionIds: [FB.id],
        caption: '',
        article: article({ title: '', slug: 'Bad Slug' }),
      }),
    );
    expect(hasErrors(errors)).toBe(false);
  });

  it('lets an article-only body run to the article limit', () => {
    expect(hasErrors(validate(form({ caption: 'a'.repeat(CAPTION_MAX + 1) })))).toBe(false);
    expect(hasErrors(validate(form({ caption: 'a'.repeat(ARTICLE_BODY_MAX) })))).toBe(false);
    expect(validate(form({ caption: 'a'.repeat(ARTICLE_BODY_MAX + 7) })).caption).toBe(
      'The article is 7 over the 100000 character limit.',
    );
  });

  it('holds a mixed selection to the social limit, and says what to do', () => {
    const errors = validate(
      form({ connectionIds: [FB.id, WP.id], caption: 'a'.repeat(CAPTION_MAX + 12) }),
    );
    expect(errors.caption).toContain('12 over the 5000 character limit of the social accounts');
    expect(errors.caption).toContain('post the article on its own');
  });

  it('still reports a plain caption over the limit as before', () => {
    const errors = validate(form({ connectionIds: [FB.id], caption: 'a'.repeat(CAPTION_MAX + 3) }));
    expect(errors.caption).toBe('Caption is 3 over the 5000 character limit.');
  });

  it('reports a wrong article field', () => {
    expect(validate(form({ article: article({ slug: 'No Good' }) })).article?.slug).toBeDefined();
  });
});

describe('featuredImage', () => {
  it('is the first image, wherever it sits, and nothing when there is none', () => {
    expect(featuredImage([video(1), image(1), image(2)])).toEqual([image(1)]);
    expect(featuredImage([video(1)])).toEqual([]);
    expect(featuredImage([])).toEqual([]);
  });
});

describe('buildCreatePostInput for an article', () => {
  it('sends the options on the WordPress variant and inherits a short body', () => {
    const input = buildCreatePostInput(form(), conns);
    expect(input.caption).toBe('# Why\n\nBecause plastic lasts.');
    expect(input.variants).toEqual([
      {
        connectionId: WP.id,
        provider: 'wordpress',
        options: { kind: 'wordpress', title: 'Five ways to cut plastic', status: 'publish' },
      },
    ]);
    expect(createPostInput.safeParse(input).success).toBe(true);
  });

  it('puts a long body on the variant, because the shared caption cannot hold it', () => {
    const body = 'word '.repeat(4000);
    const input = buildCreatePostInput(
      form({ caption: body, connectionIds: [WP.id, WP2.id] }),
      conns,
    );
    expect(input.caption).toBe('');
    expect(input.variants.map((v) => v.caption)).toEqual([body, body]);
    expect(createPostInput.safeParse(input).success).toBe(true);
  });

  it('gives the article one featured image when the post carries a carousel', () => {
    const media = [video(1), image(1), image(2)];
    const input = buildCreatePostInput(form({ connectionIds: [IG.id, WP.id], media }), conns);
    expect(input.media).toEqual(media);
    const [ig, wp] = input.variants;
    expect(ig).toEqual({ connectionId: IG.id, provider: 'instagram' });
    expect(wp!.media).toEqual([image(1)]);
    expect(wp!.options).toMatchObject({ kind: 'wordpress' });
    expect(createPostInput.safeParse(input).success).toBe(true);
  });

  it('gives the article no media when only a video is attached', () => {
    const input = buildCreatePostInput(form({ media: [video(1)] }), conns);
    expect(input.variants[0]!.media).toEqual([]);
  });

  it('leaves the media alone when it already is exactly the featured image', () => {
    const input = buildCreatePostInput(form({ media: [image(1)] }), conns);
    expect(input.variants[0]).not.toHaveProperty('media');
  });

  it('adds nothing to a social variant', () => {
    const input = buildCreatePostInput(form({ connectionIds: [FB.id, WP.id] }), conns);
    expect(input.variants[0]).toEqual({ connectionId: FB.id, provider: 'facebook' });
  });

  it('carries every article field the form holds', () => {
    const input = buildCreatePostInput(
      form({
        article: article({
          excerpt: 'Summary.',
          slug: 'cut-plastic',
          categories: 'News',
          tags: 'plastic, eco',
          status: 'pending',
        }),
      }),
      conns,
    );
    expect(input.variants[0]!.options).toEqual({
      kind: 'wordpress',
      title: 'Five ways to cut plastic',
      status: 'pending',
      excerpt: 'Summary.',
      slug: 'cut-plastic',
      categories: ['News'],
      tags: ['plastic', 'eco'],
    });
  });
});

describe('buildValidationInput with WordPress accounts in the list', () => {
  it('is a body the contract accepts before a title has been typed', () => {
    const body = buildValidationInput({ caption: 'hi', media: [], article: emptyArticle() }, conns);
    expect(createPostInput.safeParse(body).success).toBe(true);
    const wp = body.variants.find((v) => v.provider === 'wordpress')!;
    expect(wp.options).toMatchObject({ kind: 'wordpress', title: 'Untitled' });
    // …and without any article state at all (older callers).
    expect(
      createPostInput.safeParse(buildValidationInput({ caption: '', media: [] }, conns)).success,
    ).toBe(true);
  });

  it('uses the typed title once there is one', () => {
    const body = buildValidationInput({ caption: 'hi', media: [], article: article() }, conns);
    expect(body.variants.find((v) => v.provider === 'wordpress')!.options).toMatchObject({
      title: 'Five ways to cut plastic',
    });
  });

  it('with a body too long for a caption, flags only the social accounts', () => {
    const long = 'a'.repeat(CAPTION_MAX + 1);
    const body = buildValidationInput({ caption: long, media: [], article: article() }, conns);
    expect(body.caption).toBe('');
    const parsed = createPostInput.safeParse(body);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // One issue per social variant, each on that variant's own caption; none for WordPress.
    expect(parsed.error.issues.map((i) => i.path)).toEqual([
      ['variants', 0, 'caption'],
      ['variants', 1, 'caption'],
    ]);
  });
});

describe('isDirty', () => {
  it('counts typed article fields as work that closing would lose', () => {
    expect(isDirty({ caption: '', media: [], article: emptyArticle() })).toBe(false);
    expect(isDirty({ caption: '', media: [], article: article() })).toBe(true);
    expect(isDirty({ caption: '', media: [] })).toBe(false);
    expect(articleDirty(article({ title: '', tags: 'eco' }))).toBe(true);
    // A status alone is a default, not work.
    expect(articleDirty({ ...emptyArticle(), status: 'draft' })).toBe(false);
  });
});

describe('how an article reads in lists', () => {
  const post = (over: object) =>
    ({
      id: id(50),
      groupId: id(60),
      provider: 'wordpress',
      connectionId: WP.id,
      status: 'scheduled',
      caption: '# Why\n\nA very long body…',
      options: { kind: 'wordpress', title: 'Five ways to cut plastic', status: 'publish' },
      publishAt: new Date('2026-10-12T09:00:00Z'),
      releaseUrl: null,
      error: null,
      queueId: null,
      createdAt: new Date('2026-10-10T09:00:00Z'),
      media: [],
      ...over,
    }) as never;

  it('is known by its title, not by its body', () => {
    expect(postHeadline(post({}))).toBe('Five ways to cut plastic');
    expect(postHeadline(post({ provider: 'facebook', options: null, caption: 'Hi' }))).toBe('Hi');
    expect(postHeadline(post({ options: { kind: 'meta', format: 'feed' }, caption: 'Hi' }))).toBe(
      'Hi',
    );
    expect(postHeadline(undefined)).toBe('');
  });

  it('a Content card and a Calendar entry both show the title', () => {
    expect(groupCaption({ caption: 'group text', posts: [post({})] })).toBe(
      'Five ways to cut plastic',
    );
    expect(groupCaption({ caption: 'group text', posts: [] })).toBe('group text');
    expect(dayEntries([post({})])[0]!.caption).toBe('Five ways to cut plastic');
  });

  it('knows which providers are articles', () => {
    expect(isArticleProvider('wordpress')).toBe(true);
    expect(isArticleProvider('facebook')).toBe(false);
  });
});

describe('siteAddressProblem — the Connect dialog’s first check', () => {
  it.each([
    'https://example.com',
    'example.com',
    'blog.example.com/news',
    '  https://example.com/  ',
    'HTTPS://Example.com',
    'https://example.com/wp-admin/',
  ])('lets %j through to the server', (address) => {
    expect(siteAddressProblem(address)).toBeNull();
  });

  it.each([
    ['', 'Enter the address of the site.'],
    ['   ', 'Enter the address of the site.'],
    ['my site.com', 'A web address has no spaces.'],
    ['ftp://example.com', 'Enter a website address, like https://example.com.'],
    ['javascript:alert(1)', 'Enter a website address, like https://example.com.'],
    ['mailto:me@example.com', 'Enter a website address, like https://example.com.'],
    ['https://user:pw@example.com', 'Leave the username and password out of the address.'],
    ['localhost', 'Enter the full address, like https://example.com.'],
    ['https://intranet', 'Enter the full address, like https://example.com.'],
    ['https://', 'That does not look like a web address.'],
  ])('explains %j', (address, message) => {
    expect(siteAddressProblem(address)).toBe(message);
  });

  it('explains why http is refused, in WordPress’s terms', () => {
    const message = siteAddressProblem('http://example.com');
    expect(message).toContain('https://');
    expect(message).toContain('secure sites');
    expect(siteAddressProblem('HTTP://example.com')).toBe(message);
  });
});
