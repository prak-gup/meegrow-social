import type {
  ConnectMethod,
  ConnectionView,
  PostOptions,
  PostView,
  SiteCheck,
} from '@meegrow-social/contracts';

/**
 * Pure logic for WordPress in the dashboard: what the Connect dialog can say about a typed address
 * before the server is asked, which connect method it offers once the server has looked, and how
 * the Composer's article fields become the `wordpress` options arm. Unit-testable in node
 * (apps/web vitest has no DOM).
 *
 * The limits mirror `packages/contracts/src/posts.ts`; wordpress.test.ts parses against the real
 * schema so they cannot drift unnoticed.
 */

export const ARTICLE_PROVIDER = 'wordpress';
/** A WordPress variant's own caption — the article body — may be this long. */
export const ARTICLE_BODY_MAX = 100_000;
export const ARTICLE_TITLE_MAX = 300;
export const ARTICLE_EXCERPT_MAX = 2000;
export const ARTICLE_SLUG_MAX = 200;
export const ARTICLE_CATEGORIES_MAX = 20;
export const ARTICLE_TAGS_MAX = 50;
const TERM_MAX = 200;

/** Does a post on this provider read as an article (title + body) rather than a caption? */
export const isArticleProvider = (provider: string): boolean => provider === ARTICLE_PROVIDER;

type WordPressOptions = Extract<PostOptions, { kind: 'wordpress' }>;
export type ArticleStatus = WordPressOptions['status'];

/** What the article is created as ON WORDPRESS when this post goes out — not when it goes out. */
export const ARTICLE_STATUSES: ReadonlyArray<{
  value: ArticleStatus;
  label: string;
  note: string;
}> = [
  { value: 'publish', label: 'Published', note: 'Public on the site as soon as it is sent.' },
  {
    value: 'draft',
    label: 'Draft',
    note: 'Saved on the site as a draft. Not public until someone publishes it in WordPress.',
  },
  {
    value: 'pending',
    label: 'Pending review',
    note: 'Waits for an editor on the site to approve it. Not public until then.',
  },
  { value: 'private', label: 'Private', note: 'Visible only to logged-in editors of the site.' },
];

/** The Composer's article fields, as typed. Categories and tags are comma-separated names. */
export interface ArticleForm {
  title: string;
  excerpt: string;
  slug: string;
  categories: string;
  tags: string;
  status: ArticleStatus;
}

export const emptyArticle = (): ArticleForm => ({
  title: '',
  excerpt: '',
  slug: '',
  categories: '',
  tags: '',
  status: 'publish',
});

/** "News,  Eco tips ,news" → ["News", "Eco tips"]: trimmed, blanks dropped, repeats (any case) once. */
export function parseTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const term = raw.trim().replace(/\s+/g, ' ');
    const key = term.toLowerCase();
    if (term === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/** A title → the slug WordPress would be happy with: "Five Ways (2026)!" → "five-ways-2026". */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ARTICLE_SLUG_MAX)
    .replace(/-+$/, '');
}

export interface ArticleErrors {
  title?: string;
  excerpt?: string;
  slug?: string;
  categories?: string;
  tags?: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateArticle(article: ArticleForm): ArticleErrors {
  const errors: ArticleErrors = {};
  const title = article.title.trim();
  if (title === '') errors.title = 'An article needs a title.';
  else if (title.length > ARTICLE_TITLE_MAX) {
    errors.title = `The title is ${title.length - ARTICLE_TITLE_MAX} over the ${ARTICLE_TITLE_MAX} character limit.`;
  }
  if (article.excerpt.length > ARTICLE_EXCERPT_MAX) {
    errors.excerpt = `The excerpt is ${article.excerpt.length - ARTICLE_EXCERPT_MAX} over the ${ARTICLE_EXCERPT_MAX} character limit.`;
  }
  const slug = article.slug.trim();
  if (slug !== '' && (!SLUG.test(slug) || slug.length > ARTICLE_SLUG_MAX)) {
    const suggestion = slugify(slug);
    errors.slug =
      'Use lowercase letters, numbers and single hyphens only' +
      (suggestion ? ` — for example “${suggestion}”.` : '.');
  }
  for (const [field, max] of [
    ['categories', ARTICLE_CATEGORIES_MAX],
    ['tags', ARTICLE_TAGS_MAX],
  ] as const) {
    const terms = parseTerms(article[field]);
    if (terms.length > max) errors[field] = `At most ${max} ${field}.`;
    else if (terms.some((t) => t.length > TERM_MAX)) {
      errors[field] = `Each name can be at most ${TERM_MAX} characters.`;
    }
  }
  return errors;
}

/** The `wordpress` options arm for a form. Empty optional fields are left out, not sent blank. */
export function articleOptions(article: ArticleForm): WordPressOptions {
  const categories = parseTerms(article.categories);
  const tags = parseTerms(article.tags);
  return {
    kind: 'wordpress',
    title: article.title.trim(),
    status: article.status,
    ...(article.excerpt.trim() ? { excerpt: article.excerpt.trim() } : {}),
    ...(article.slug.trim() ? { slug: article.slug.trim() } : {}),
    ...(categories.length > 0 ? { categories } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/** Has anything been typed into the article fields that closing would throw away? */
export function articleDirty(article: ArticleForm | undefined): boolean {
  if (!article) return false;
  return [article.title, article.excerpt, article.slug, article.categories, article.tags].some(
    (v) => v.trim() !== '',
  );
}

/**
 * The line a post is known by in a list: an article's title, anything else's caption. An article's
 * caption is its whole body — pages of Markdown — which is not what a card or a calendar cell is for.
 */
export function postHeadline(post: Pick<PostView, 'caption' | 'options'> | undefined): string {
  if (!post) return '';
  return post.options?.kind === 'wordpress'
    ? post.options.remote?.title || post.options.title
    : post.caption;
}

/**
 * What can be said about a typed site address before asking the server, or null when it looks
 * usable. Deliberately shallow: whether the address is a WordPress site, is reachable, and may be
 * contacted at all is the server's to decide (it runs the SSRF guard) — this only saves a round
 * trip for the obvious slips.
 */
export function siteAddressProblem(input: string): string | null {
  const text = input.trim();
  if (text === '') return 'Enter the address of the site.';
  if (/\s/.test(text)) return 'A web address has no spaces.';
  if (/^http:\/\//i.test(text)) {
    return 'The address must start with https://. WordPress only allows this kind of connection on secure sites.';
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https:\/\//i.test(text)) {
    return 'Enter a website address, like https://example.com.';
  }
  let url: URL;
  try {
    url = new URL(/^https:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return 'That does not look like a web address.';
  }
  if (url.username !== '' || url.password !== '') {
    return 'Leave the username and password out of the address.';
  }
  if (!url.hostname.includes('.')) return 'Enter the full address, like https://example.com.';
  return null;
}

/**
 * The method the dialog starts on once the site has been checked: approval wherever the site
 * offers it (WordPress then issues a separate password and none is typed here), a username and
 * password only where it does not. Null when the site can be connected neither way.
 */
export function defaultConnectMethod(
  check: Pick<SiteCheck, 'approval' | 'password'>,
): ConnectMethod | null {
  if (check.approval.available) return 'approval';
  return check.password.available ? 'password' : null;
}

export interface MethodGuidance {
  /** `switch`: approval is out but a login works. `stop`: nothing works yet. */
  kind: 'switch' | 'stop';
  title: string;
  detail: string;
}

/**
 * What to say above the two methods when the recommended one is not available — so a site with
 * Application Passwords switched off is offered the other way in, not an error to stare at. Null
 * when approval is available: there is nothing to explain.
 */
export function methodGuidance(
  check: Pick<SiteCheck, 'approval' | 'password'>,
): MethodGuidance | null {
  if (check.approval.available) return null;
  if (check.password.available) {
    return {
      kind: 'switch',
      title: 'This site cannot be connected by approval',
      detail: 'It can be connected with a WordPress username and password instead.',
    };
  }
  return {
    kind: 'stop',
    title: 'This site cannot be connected yet',
    detail: 'Neither way of connecting works on it right now. The reasons are below.',
  };
}

/**
 * A WordPress can be read at one address and managed at another (Site Address and WordPress
 * Address in its settings). When they differ the dialog says so, because the person typed one and
 * is about to see the other. Null when they are the same, or unknown.
 */
export function separateAddressesNote(
  check: Pick<SiteCheck, 'separateAddresses' | 'siteAddress' | 'homeAddress'>,
): string | null {
  if (!check.separateAddresses || !check.siteAddress || !check.homeAddress) return null;
  return (
    `This WordPress has two addresses: visitors read it at ${check.homeAddress}, and it is ` +
    `managed at ${check.siteAddress}. Either one works here.`
  );
}

/** WordPress's own limit on a login name; a password this long is not one. Mirrors contracts. */
export const SITE_USERNAME_MAX = 100;
export const SITE_PASSWORD_MAX = 512;

/** What is wrong with the login form as typed, per field. The password is never trimmed. */
export function siteLoginProblems(login: { username: string; password: string }): {
  username?: string;
  password?: string;
} {
  const problems: { username?: string; password?: string } = {};
  const username = login.username.trim();
  if (username === '') problems.username = 'Enter the WordPress username.';
  else if (username.length > SITE_USERNAME_MAX) problems.username = 'That username is too long.';
  if (login.password === '') problems.password = 'Enter the password.';
  else if (login.password.length > SITE_PASSWORD_MAX) {
    problems.password = 'That password is too long.';
  }
  return problems;
}

/**
 * The line under an account's name on the Connections table. A connection that holds a login
 * password says so — "WordPress · password · https://…" — so it stays visible long after whoever
 * typed it has forgotten.
 */
export function connectionSubline(
  platformLabel: string,
  connection: Pick<ConnectionView, 'externalId' | 'method'>,
): string {
  const parts = [platformLabel];
  if (connection.method === 'password') parts.push('password');
  parts.push(connection.externalId);
  return parts.join(' · ');
}
