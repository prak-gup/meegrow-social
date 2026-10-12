import { ARTICLE_BODY_MAX, type WordPressRemoteArticle } from '@meegrow-social/contracts';
import { ProviderBadRequestError } from '../../errors.js';
import type {
  PublishedPostItem,
  PublishedPostPage,
  PublishedPostQuery,
  PublishedPostPresence,
} from '../published-posts.js';
import type { AuthTokens } from '../types.js';
import { decodeCredentials, plainText, type WordPressClient } from './client.js';
import { XmlRpcFaultError, type WordPressXmlRpcClient } from './xmlrpc-client.js';
import { asArray, asStruct } from './xmlrpc.js';

// Documentation-built shapes: WP REST posts schema and XML-RPC wp.getPosts (research §10/11).
type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as RecordValue) : {};
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const raw = (v: unknown): string => text(record(v).raw ?? record(v).rendered);
const statuses = new Set(['publish', 'draft', 'pending', 'future', 'private']);

/** Both APIs return GMT dates without a zone; XML-RPC uses compact ISO8601. */
export function articleDate(value: unknown): Date {
  const source = text(value).replace(/^(\d{4})(\d{2})(\d{2})T/, '$1-$2-$3T');
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(source) ? source : `${source}Z`);
  if (!source || !Number.isFinite(date.getTime())) {
    throw new ProviderBadRequestError('WordPress returned an article without a valid GMT date.');
  }
  return date;
}

function item(
  id: unknown,
  body: string,
  link: unknown,
  image: unknown,
  facts: Omit<WordPressRemoteArticle, 'bodyFormat' | 'bodyTruncated'>,
): PublishedPostItem {
  if (!/^\d+$/.test(String(id)) || Number(id) <= 0 || !statuses.has(facts.status)) {
    throw new ProviderBadRequestError('WordPress returned an invalid article id or status.');
  }
  const remote: WordPressRemoteArticle = {
    ...facts,
    bodyFormat: 'html',
    bodyTruncated: body.length > ARTICLE_BODY_MAX,
  };
  const thumbnailUrl = typeof image === 'string' && image.startsWith('https://') ? image : null;
  return {
    externalPostId: String(id),
    alternateIds: [],
    knownUrls: [],
    caption: body.slice(0, ARTICLE_BODY_MAX),
    publishedAt: new Date(facts.publishedAt ?? facts.modifiedAt),
    permalink: typeof link === 'string' && link.startsWith('https://') ? link : null,
    mediaKind: thumbnailUrl ? 'image' : null,
    mediaCount: thumbnailUrl ? 1 : 0,
    thumbnailUrl,
    options: {
      kind: 'wordpress',
      title: (facts.title || '(Untitled article)').slice(0, 300),
      status: facts.status === 'future' ? 'draft' : facts.status,
      remote,
    },
  };
}

export async function listArticles(
  client: WordPressClient,
  xmlrpc: WordPressXmlRpcClient,
  tokens: AuthTokens,
  query: PublishedPostQuery,
): Promise<PublishedPostPage> {
  const credentials = decodeCredentials(tokens.accessToken);
  const limit = Math.min(25, Math.max(1, Math.floor(query.limit)));
  const cursor = query.cursor === undefined ? 0 : Number(query.cursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new ProviderBadRequestError('Invalid WordPress article cursor.');
  if (credentials.transport === 'xmlrpc') {
    const value = await xmlrpc.call(credentials, 'wp.getPosts', [
      {
        post_type: 'post',
        post_status: 'publish,draft,pending,future,private',
        number: limit,
        offset: cursor,
        orderby: 'date',
        order: 'DESC',
      },
    ]);
    const posts = asArray(value);
    if (!posts) throw new ProviderBadRequestError('WordPress returned an invalid article list.');
    const authors = new Map<string, string>();
    const items: PublishedPostItem[] = [];
    for (const value of posts) {
      const post = asStruct(value);
      if (!post) throw new ProviderBadRequestError('WordPress returned an invalid article.');
      const authorId = String(post.post_author ?? '');
      if (authorId && !authors.has(authorId)) {
        // Editors may read posts but lack edit_users for another author's profile.
        const user = asStruct(
          await xmlrpc.call(credentials, 'wp.getUser', [Number(authorId)]).catch(() => null),
        );
        authors.set(authorId, plainText(user?.display_name));
      }
      const terms = (asArray(post.terms) ?? []).map(asStruct);
      items.push(
        item(
          post.post_id,
          text(post.post_content),
          post.link,
          asStruct(post.post_thumbnail)?.link,
          {
            title: plainText(post.post_title),
            excerpt: text(post.post_excerpt),
            slug: text(post.post_name),
            status: text(post.post_status) as WordPressRemoteArticle['status'],
            publishedAt: articleDate(post.post_date_gmt).toISOString(),
            modifiedAt: articleDate(post.post_modified_gmt).toISOString(),
            categories: terms
              .filter((t) => t?.taxonomy === 'category')
              .map((t) => plainText(t?.name)),
            tags: terms.filter((t) => t?.taxonomy === 'post_tag').map((t) => plainText(t?.name)),
            author: authors.get(authorId) ?? '',
          },
        ),
      );
    }
    return {
      items,
      nextCursor: posts.length === limit ? String(cursor + limit) : null,
      usage: null,
    };
  }
  const page = cursor + 1;
  const result = await client.tryRequest<unknown[]>(credentials, '/wp/v2/posts', {
    maxResponseBytes: 8 * 1024 * 1024,
    query: {
      context: 'edit',
      status: 'publish,draft,pending,future,private',
      per_page: String(limit),
      page: String(page),
      _embed: '1',
      orderby: 'date',
      order: 'desc',
    },
  });
  if ('failure' in result) throw result.failure.error;
  if (!Array.isArray(result.data))
    throw new ProviderBadRequestError('WordPress returned an invalid article list.');
  const cache = new Map<string, RecordValue>();
  const lookup = async (path: string): Promise<RecordValue> => {
    if (!cache.has(path)) cache.set(path, record(await client.request(credentials, path)));
    return cache.get(path)!;
  };
  const items: PublishedPostItem[] = [];
  for (const value of result.data) {
    const post = record(value);
    const embedded = record(post._embedded);
    const media = Array.isArray(embedded['wp:featuredmedia'])
      ? record(embedded['wp:featuredmedia'][0])
      : {};
    const image =
      media.source_url ??
      (Number(post.featured_media) > 0
        ? (await lookup(`/wp/v2/media/${Number(post.featured_media)}`)).source_url
        : null);
    const author = Array.isArray(embedded.author)
      ? record(embedded.author[0])
      : Number(post.author) > 0
        ? await lookup(`/wp/v2/users/${Number(post.author)}`)
        : {};
    const terms = Array.isArray(embedded['wp:term']) ? embedded['wp:term'].flat().map(record) : [];
    const names = async (
      taxonomy: 'category' | 'post_tag',
      route: 'categories' | 'tags',
    ): Promise<string[]> => {
      const ids = Array.isArray(post[route]) ? post[route] : [];
      const found: string[] = [];
      for (const id of ids) {
        const term =
          terms.find((t) => t.taxonomy === taxonomy && t.id === id) ??
          (await lookup(`/wp/v2/${route}/${Number(id)}`));
        found.push(plainText(term.name));
      }
      return found;
    };
    items.push(
      item(post.id, raw(post.content), post.link, image, {
        title: plainText(raw(post.title)),
        excerpt: raw(post.excerpt),
        slug: text(post.slug),
        status: text(post.status) as WordPressRemoteArticle['status'],
        publishedAt: post.date_gmt ? articleDate(post.date_gmt).toISOString() : null,
        modifiedAt: articleDate(post.modified_gmt).toISOString(),
        categories: await names('category', 'categories'),
        tags: await names('post_tag', 'tags'),
        author: plainText(author.name),
      }),
    );
  }
  const pages = Number(result.headers['x-wp-totalpages']);
  if (!Number.isSafeInteger(pages) || pages < 0)
    throw new ProviderBadRequestError(
      'WordPress omitted the article pagination count; refresh after checking the site API.',
    );
  return { items, nextCursor: page < pages ? String(cursor + 1) : null, usage: null };
}

export async function articlePresence(
  client: WordPressClient,
  xmlrpc: WordPressXmlRpcClient,
  tokens: AuthTokens,
  id: string,
): Promise<PublishedPostPresence> {
  if (!/^\d+$/.test(id)) return 'unknown';
  try {
    const credentials = decodeCredentials(tokens.accessToken);
    if (credentials.transport === 'xmlrpc') {
      const value = asStruct(
        await xmlrpc.call(credentials, 'wp.getPost', [Number(id), ['post_id', 'post_status']]),
      );
      return value?.post_status === 'trash'
        ? 'gone'
        : value && String(value.post_id) === id
          ? 'present'
          : 'unknown';
    }
    const result = await client.tryRequest<RecordValue>(credentials, `/wp/v2/posts/${id}`, {
      query: { context: 'edit' },
    });
    if ('failure' in result)
      return result.failure.code === 'rest_post_invalid_id' ? 'gone' : 'unknown';
    return result.data.status === 'trash'
      ? 'gone'
      : String(result.data.id) === id
        ? 'present'
        : 'unknown';
  } catch (error) {
    return error instanceof XmlRpcFaultError && error.code === 404 ? 'gone' : 'unknown';
  }
}
