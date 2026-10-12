import {
  articleMarkdownToHtml,
  type RemotePostFields,
  type WordPressRemoteArticle,
} from '@meegrow-social/contracts';
import { ProviderBadRequestError, ProviderConflictError } from '../../errors.js';
import type { AuthTokens } from '../types.js';
import type { PublishedPostItem } from '../published-posts.js';
import { articleDate, articleItem } from './articles.js';
import { decodeCredentials, plainText, type WordPressClient } from './client.js';
import type { WordPressXmlRpcClient } from './xmlrpc-client.js';
import { asArray, asStruct, type XmlRpcValue } from './xmlrpc.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const raw = (value: unknown) => text(record(value).raw ?? record(value).rendered);
export class RemoteArticleMismatchError extends ProviderBadRequestError {
  constructor(
    message: string,
    readonly observed: PublishedPostItem,
  ) {
    super(message);
  }
}
export function assertRemoteVersion(actual: unknown, expected: string): void {
  if (articleDate(actual).toISOString() !== expected) {
    throw new ProviderConflictError(
      'This article changed on the site — refresh from site before saving or trashing.',
    );
  }
}
function assertId(id: string) {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new ProviderBadRequestError('Invalid WordPress article ID.');
}

/** Single authenticated observation; credentials and transport response never leave this module. */
export async function readArticle(
  client: WordPressClient,
  xmlrpc: WordPressXmlRpcClient,
  tokens: AuthTokens,
  id: string,
): Promise<PublishedPostItem> {
  assertId(id);
  const credentials = decodeCredentials(tokens.accessToken);
  if (credentials.transport === 'xmlrpc') {
    const p = asStruct(await xmlrpc.call(credentials, 'wp.getPost', [Number(id)]));
    if (!p || String(p.post_id) !== id)
      throw new ProviderBadRequestError('WordPress did not return the requested article.');
    const author = p.post_author
      ? asStruct(
          await xmlrpc.call(credentials, 'wp.getUser', [Number(p.post_author)]).catch(() => null),
        )
      : null;
    const terms = (asArray(p.terms) ?? []).map(asStruct);
    const taxonomy = (name: string) => terms.filter((t) => t?.taxonomy === name);
    return articleItem(p.post_id, text(p.post_content), p.link, asStruct(p.post_thumbnail)?.link, {
      title: plainText(p.post_title),
      excerpt: text(p.post_excerpt),
      slug: text(p.post_name),
      status: text(p.post_status) as WordPressRemoteArticle['status'],
      publishedAt: articleDate(p.post_date_gmt).toISOString(),
      modifiedAt: articleDate(p.post_modified_gmt).toISOString(),
      categories: taxonomy('category').map((t) => plainText(t?.name)),
      tags: taxonomy('post_tag').map((t) => plainText(t?.name)),
      categoryIds: taxonomy('category').map((t) => Number(t?.term_id)),
      tagIds: taxonomy('post_tag').map((t) => Number(t?.term_id)),
      featuredMediaId: Number(asStruct(p.post_thumbnail)?.attachment_id ?? 0),
      author: plainText(author?.display_name),
    });
  }
  const p = record(
    await client.request(credentials, `/wp/v2/posts/${id}`, {
      query: { context: 'edit', _embed: '1' },
    }),
  );
  if (String(p.id) !== id)
    throw new ProviderBadRequestError('WordPress did not return the requested article.');
  const embedded = record(p._embedded);
  const terms = Array.isArray(embedded['wp:term']) ? embedded['wp:term'].flat().map(record) : [];
  const ids = (name: string) => (Array.isArray(p[name]) ? p[name].map(Number) : []);
  const names = async (name: 'categories' | 'tags') => {
    const found: string[] = [];
    for (const id of ids(name)) {
      const term =
        terms.find(
          (t) =>
            Number(t.id) === id && t.taxonomy === (name === 'categories' ? 'category' : 'post_tag'),
        ) ?? record(await client.request(credentials, `/wp/v2/${name}/${id}`));
      found.push(plainText(term.name));
    }
    return found;
  };
  const media = Array.isArray(embedded['wp:featuredmedia'])
    ? record(embedded['wp:featuredmedia'][0])
    : Number(p.featured_media) > 0
      ? record(await client.request(credentials, `/wp/v2/media/${Number(p.featured_media)}`))
      : {};
  const author = Array.isArray(embedded.author) ? record(embedded.author[0]) : {};
  return articleItem(p.id, raw(p.content), p.link, media.source_url, {
    title: plainText(raw(p.title)),
    excerpt: raw(p.excerpt),
    slug: text(p.slug),
    status: text(p.status) as WordPressRemoteArticle['status'],
    publishedAt: p.date_gmt ? articleDate(p.date_gmt).toISOString() : null,
    modifiedAt: articleDate(p.modified_gmt).toISOString(),
    categories: await names('categories'),
    tags: await names('tags'),
    categoryIds: ids('categories'),
    tagIds: ids('tags'),
    featuredMediaId: Number(p.featured_media ?? 0),
    author: plainText(author.name),
  });
}

/** Compare only requested fields; a site filter may reject/alter a write. Never claim it persisted. */
export function verifyArticleWrite(
  article: PublishedPostItem,
  fields: RemotePostFields,
  format: 'html' | 'markdown',
): void {
  const remote = article.options?.kind === 'wordpress' ? article.options.remote : undefined;
  const actual: RecordValue = {
    title: remote?.title,
    body: article.caption,
    excerpt: remote?.excerpt,
    slug: remote?.slug,
    status: remote?.status,
    categories: remote?.categoryIds,
    tags: remote?.tagIds,
    featuredImage: remote?.featuredMediaId,
  };
  for (const [key, value] of Object.entries(fields)) {
    const expected =
      key === 'body' && format === 'markdown' ? articleMarkdownToHtml(String(value)) : value;
    const normalize = (v: unknown) =>
      Array.isArray(v) ? JSON.stringify([...v].sort((a, b) => Number(a) - Number(b))) : v;
    if (
      (key === 'body' && remote?.bodyTruncated) ||
      normalize(actual[key]) !== normalize(expected)
    ) {
      throw new RemoteArticleMismatchError(
        `WordPress did not store the requested ${key}. Refresh from site to see what was saved; do not blindly retry.`,
        article,
      );
    }
  }
}

export async function updateArticle(
  client: WordPressClient,
  xmlrpc: WordPressXmlRpcClient,
  tokens: AuthTokens,
  id: string,
  expected: string,
  fields: RemotePostFields,
  format: 'html' | 'markdown',
): Promise<PublishedPostItem> {
  const before = await readArticle(client, xmlrpc, tokens, id);
  assertRemoteVersion(
    before.options?.kind === 'wordpress' ? before.options.remote?.modifiedAt : '',
    expected,
  );
  if (
    fields.body !== undefined &&
    before.options?.kind === 'wordpress' &&
    before.options.remote?.bodyTruncated
  )
    throw new ProviderBadRequestError('Body is truncated for storage; body editing is disabled.');
  const credentials = decodeCredentials(tokens.accessToken);
  const body =
    fields.body === undefined
      ? undefined
      : format === 'markdown'
        ? articleMarkdownToHtml(fields.body)
        : fields.body;
  if (credentials.transport === 'xmlrpc') {
    const patch: Record<string, XmlRpcValue> = {};
    for (const [field, key] of Object.entries({
      title: 'post_title',
      excerpt: 'post_excerpt',
      slug: 'post_name',
      status: 'post_status',
      featuredImage: 'post_thumbnail',
    })) {
      const value = fields[field as keyof RemotePostFields];
      if (value !== undefined) patch[key] = value;
    }
    if (body !== undefined) patch.post_content = body;
    if (fields.categories !== undefined || fields.tags !== undefined)
      patch.terms = {
        ...(fields.categories !== undefined ? { category: fields.categories } : {}),
        ...(fields.tags !== undefined ? { post_tag: fields.tags } : {}),
      };
    await xmlrpc.call(credentials, 'wp.editPost', [Number(id), patch]);
  } else {
    const rest = { ...fields };
    delete rest.body;
    delete rest.featuredImage;
    const featuredImage = fields.featuredImage;
    await client.request(credentials, `/wp/v2/posts/${id}`, {
      method: 'POST',
      json: {
        ...rest,
        ...(body !== undefined ? { content: body } : {}),
        ...(featuredImage !== undefined ? { featured_media: featuredImage } : {}),
      },
    });
  }
  let after: PublishedPostItem;
  try {
    after = await readArticle(client, xmlrpc, tokens, id);
  } catch (error) {
    if (error instanceof Error)
      error.message = `The change may have been applied, but read-back failed. Refresh from site before retrying. ${error.message}`;
    throw error;
  }
  verifyArticleWrite(after, fields, format);
  return after;
}

export async function trashArticle(
  client: WordPressClient,
  xmlrpc: WordPressXmlRpcClient,
  tokens: AuthTokens,
  id: string,
  expected: string,
): Promise<void> {
  const before = await readArticle(client, xmlrpc, tokens, id);
  assertRemoteVersion(
    before.options?.kind === 'wordpress' ? before.options.remote?.modifiedAt : '',
    expected,
  );
  const credentials = decodeCredentials(tokens.accessToken);
  let after: RecordValue;
  if (credentials.transport === 'xmlrpc') {
    // wp.deletePost falls back to permanent deletion when EMPTY_TRASH_DAYS is zero.
    // XML-RPC cannot expose that setting. Use the status edit to guarantee a restorable trash
    // transition instead of risking an irreversible delete on a site with trash disabled.
    await xmlrpc.call(credentials, 'wp.editPost', [Number(id), { post_status: 'trash' }]);
    after = record(asStruct(await xmlrpc.call(credentials, 'wp.getPost', [Number(id)])));
    if (String(after.post_id) !== id || after.post_status !== 'trash')
      throw new ProviderBadRequestError(
        'WordPress trash was not confirmed — check the site before trying again.',
      );
  } else {
    await client.request(credentials, `/wp/v2/posts/${id}`, {
      method: 'DELETE',
      query: { force: 'false' },
    });
    after = record(
      await client.request(credentials, `/wp/v2/posts/${id}`, { query: { context: 'edit' } }),
    );
    if (String(after.id) !== id || after.status !== 'trash')
      throw new ProviderBadRequestError(
        'WordPress trash was not confirmed — check the site before trying again.',
      );
  }
}
