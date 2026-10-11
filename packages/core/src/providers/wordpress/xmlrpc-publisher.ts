import { articleMarkdownToHtml, type MediaRef, type PostOptions } from '@meegrow-social/contracts';
import { ProviderBadRequestError } from '../../errors.js';
import type { PostDetails, PostResult } from '../types.js';
import { fileStem, permalink, statusNotice, uploadExtension } from './article.js';
import type { WordPressClient, WordPressXmlRpcCredentials } from './client.js';
import type { WordPressXmlRpcClient, XmlRpcLogin, XmlRpcStoredPost } from './xmlrpc-client.js';
import type { XmlRpcStruct } from './xmlrpc.js';

type WordPressOptions = Extract<PostOptions, { kind: 'wordpress' }>;

/**
 * Publish one article over XML-RPC — the same article, the same Markdown→HTML conversion and the
 * same rules as the REST path (`WordPressProvider.post`), carried by `wp.newPost`.
 *
 * Two things differ, both because of what XML-RPC is:
 *
 *  - Categories are sent as term IDS (`terms`), never as names. `terms_names` would CREATE a
 *    category that does not exist; the REST path refuses an unknown category, so the names are
 *    looked up with `wp.getTerms` first and an unknown one fails the post here too. Tags are sent
 *    by name (`terms_names`), which creates the ones that do not exist — also what REST does.
 *
 *  - `wp.newPost` answers with an id and nothing else. An id says a post was made, not what was
 *    stored in it, so the post is read back with `wp.getPost` and what is reported comes from
 *    THAT: its permalink, its status, whether the featured image and the categories are on it. A
 *    difference becomes a notice on the event log. An id whose post is not there is a failure.
 */
export async function postOverXmlRpc(
  deps: { xmlrpc: WordPressXmlRpcClient; images: Pick<WordPressClient, 'download'> },
  credentials: WordPressXmlRpcCredentials,
  detail: PostDetails,
  options: WordPressOptions,
  home: string,
): Promise<PostResult> {
  const { xmlrpc } = deps;
  const login: XmlRpcLogin = {
    endpoint: credentials.endpoint,
    username: credentials.username,
    password: credentials.password,
  };

  // Everything that can be refused is done BEFORE the article exists, as on the REST path.
  const categoryIds: number[] = [];
  for (const term of options.categories ?? []) {
    if (typeof term === 'number') {
      categoryIds.push(term);
      continue;
    }
    const found = await xmlrpc.findTerm(login, 'category', term);
    if (found === null) {
      throw new ProviderBadRequestError(
        `The site has no category named "${term}". Create it in WordPress, or correct the name.`,
      );
    }
    categoryIds.push(found);
  }
  const categories = [...new Set(categoryIds)];
  const tagIds = [...new Set((options.tags ?? []).filter((t) => typeof t === 'number'))];
  const tagNames = uniqueNames((options.tags ?? []).filter((t) => typeof t === 'string'));
  const thumbnail = detail.media[0]
    ? await uploadFeaturedImage(deps, login, detail.media[0], options.title)
    : undefined;

  const terms: XmlRpcStruct = {
    ...(categories.length > 0 ? { category: categories } : {}),
    ...(tagIds.length > 0 ? { post_tag: tagIds } : {}),
  };
  const id = await xmlrpc.newPost(login, {
    post_type: 'post',
    post_status: options.status,
    post_title: options.title,
    post_content: articleMarkdownToHtml(detail.caption),
    ...(options.slug ? { post_name: options.slug } : {}),
    ...(options.excerpt ? { post_excerpt: options.excerpt } : {}),
    ...(thumbnail !== undefined ? { post_thumbnail: thumbnail } : {}),
    ...(Object.keys(terms).length > 0 ? { terms } : {}),
    ...(tagNames.length > 0 ? { terms_names: { post_tag: tagNames } } : {}),
  });

  // From here on the article exists. Nothing below may end in a retry: that would publish it twice.
  let stored: XmlRpcStoredPost | null;
  try {
    stored = await xmlrpc.getPost(login, id);
  } catch {
    return {
      externalPostId: String(id),
      releaseUrl: permalink(null, home, id),
      notice:
        `WordPress created the article (post ${id}), but it could not be read back, so what ` +
        'was stored is NOT confirmed — check it on the site.',
    };
  }
  if (stored === null || stored.id !== id) {
    throw new ProviderBadRequestError(
      `WordPress answered that it created post ${id}, but the site has no such post. Check the ` +
        'site before retrying, so it is not published twice.',
    );
  }

  const notices: string[] = [];
  if (stored.status !== 'publish') notices.push(statusNotice(stored.status, options.status));
  if (thumbnail !== undefined && stored.thumbnailId !== thumbnail) {
    notices.push('WordPress saved the article without its featured image.');
  }
  const missing = (asked: number[], taxonomy: string): number =>
    asked.filter((term) => !(stored.terms[taxonomy] ?? []).includes(term)).length;
  if (missing(categories, 'category') > 0) {
    notices.push('WordPress saved the article without some of the categories asked for.');
  }
  if (
    missing(tagIds, 'post_tag') > 0 ||
    (stored.terms.post_tag ?? []).length < Math.max(tagNames.length, tagIds.length)
  ) {
    notices.push('WordPress saved the article without some of the tags asked for.');
  }
  return {
    externalPostId: String(id),
    releaseUrl: permalink(stored.link, home, id),
    ...(notices.length > 0 ? { notice: notices.join(' ') } : {}),
  };
}

/** The same tag in two spellings of its case is one tag to WordPress. */
function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.trim().toLowerCase();
    if (key === '' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function uploadFeaturedImage(
  deps: { xmlrpc: WordPressXmlRpcClient; images: Pick<WordPressClient, 'download'> },
  login: XmlRpcLogin,
  media: MediaRef,
  title: string,
): Promise<number> {
  if (!media.url) {
    throw new ProviderBadRequestError(`media ${media.mediaId} has no stored url`);
  }
  const image = await deps.images.download(media.url);
  const extension = uploadExtension(image.contentType);
  return deps.xmlrpc.uploadFile(login, {
    name: `${fileStem(title)}.${extension}`,
    type: image.contentType,
    bits: image.body,
  });
}
