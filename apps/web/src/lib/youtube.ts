import type { PostOptions, PostView } from '@meegrow-social/contracts';

export interface YouTubeForm {
  title: string;
  /** Undefined follows the shared caption until edited. */
  description?: string;
  privacyStatus: 'public' | 'unlisted' | 'private';
  tags: string;
  categoryId: string;
  madeForKids: '' | 'yes' | 'no';
}
export const emptyYouTube = (): YouTubeForm => ({
  title: '',
  privacyStatus: 'private',
  tags: '',
  categoryId: '22',
  madeForKids: '',
});
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;
export function youtubeVisibilitySummary(posts: readonly PostView[]): string[] {
  return posts
    .filter((p) => p.provider === 'youtube')
    .map((p) =>
      p.options?.kind === 'youtube' && p.status === 'published'
        ? `YouTube visibility: ${p.options.remote?.privacyStatus ?? 'awaiting YouTube confirmation'}`
        : 'YouTube visibility will appear after publishing. You can also check Content.',
    );
}
export const youtubeTags = (text: string): string[] =>
  text
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
/** YouTube counts separators and enclosing quotes for tags containing spaces. */
export const youtubeTagLength = (text: string): number => {
  const tags = youtubeTags(text);
  return (
    tags.reduce((sum, tag) => sum + tag.length + (/\s/.test(tag) ? 2 : 0), 0) +
    Math.max(0, tags.length - 1)
  );
};
/** Documentation-built ids: YouTube videoCategories reference and public category listings. */
export const YOUTUBE_CATEGORIES = [
  ['1', 'Film & Animation'],
  ['2', 'Autos & Vehicles'],
  ['10', 'Music'],
  ['15', 'Pets & Animals'],
  ['17', 'Sports'],
  ['19', 'Travel & Events'],
  ['20', 'Gaming'],
  ['22', 'People & Blogs'],
  ['23', 'Comedy'],
  ['24', 'Entertainment'],
  ['25', 'News & Politics'],
  ['26', 'Howto & Style'],
  ['27', 'Education'],
  ['28', 'Science & Technology'],
] as const;
export function youtubeOptions(form: YouTubeForm): Extract<PostOptions, { kind: 'youtube' }> {
  return {
    kind: 'youtube',
    title: form.title,
    ...(form.description !== undefined ? { description: form.description } : {}),
    privacyStatus: form.privacyStatus,
    categoryId: form.categoryId,
    tags: youtubeTags(form.tags),
    madeForKids: form.madeForKids === 'yes',
  };
}
export function youtubeDirty(form?: YouTubeForm): boolean {
  return Boolean(
    form &&
    (form.title ||
      form.description !== undefined ||
      form.tags ||
      form.madeForKids ||
      form.privacyStatus !== 'private' ||
      form.categoryId !== '22'),
  );
}

/** Storage accepts video MIME types and caps uploads at 1200 MiB. */
export function youtubeFileError(file: Pick<File, 'type' | 'size' | 'name'>): string | null {
  if (!file.type.startsWith('video/')) return 'YouTube needs a video file with a video MIME type.';
  if (file.size <= 0) return 'YouTube needs a non-empty video file.';
  if (file.size > 1200 * 1024 * 1024)
    return 'YouTube video exceeds the app upload limit of 1200 MiB.';
  return null;
}
