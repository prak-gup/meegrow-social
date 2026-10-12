import type { PostView, RemotePostFields } from '@meegrow-social/contracts';
import { updateRemotePostInput } from '@meegrow-social/contracts';
import { blogOptions } from './blog';
export function articleFields(post: PostView): RemotePostFields {
  const remote = blogOptions(post)?.remote;
  return {
    title: remote?.title ?? blogOptions(post)?.title ?? '',
    body: post.caption,
    excerpt: remote?.excerpt ?? '',
    slug: remote?.slug ?? '',
    ...(remote?.status !== 'future' ? { status: remote?.status ?? 'draft' } : {}),
    categories: remote?.categoryIds ?? [],
    tags: remote?.tagIds ?? [],
    featuredImage: remote?.featuredMediaId ?? 0,
  };
}
export function articlePatch(post: PostView, edited: RemotePostFields) {
  const original = articleFields(post);
  const fields = Object.fromEntries(
    Object.entries(edited).filter(
      ([key, value]) =>
        JSON.stringify(value) !== JSON.stringify(original[key as keyof RemotePostFields]),
    ),
  );
  if (blogOptions(post)?.remote?.bodyTruncated) delete fields.body;
  return updateRemotePostInput.parse({
    expectedModifiedAt: blogOptions(post)?.remote?.modifiedAt,
    fields,
  });
}
export function parseSiteIds(value: string): number[] {
  if (!value.trim()) return [];
  const ids = value.split(',').map((v) => Number(v.trim()));
  if (ids.some((v) => !Number.isSafeInteger(v) || v <= 0))
    throw new Error('Use positive site IDs separated by commas.');
  return [...new Set(ids)];
}
