import { ProviderBadRequestError } from '../../errors.js';

/**
 * What an article needs that is the same whichever transport carries it: which images WordPress
 * takes, the file name an upload is given, the URL reported for the post, and the words for a post
 * that was created but is not public.
 */

/** Image types WordPress accepts for a featured image → the extension the upload is named with. */
export const UPLOADABLE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** The extension for a downloaded image, or a refusal that says what WordPress takes. */
export function uploadExtension(contentType: string): string {
  const extension = UPLOADABLE[contentType];
  if (!extension) {
    throw new ProviderBadRequestError(
      `The featured image is ${contentType || 'of an unknown type'}; ` +
        'WordPress takes JPEG, PNG, GIF or WebP.',
    );
  }
  return extension;
}

/** A filename WordPress will keep as-is: the article's title, reduced to a slug. */
export function fileStem(title: string): string {
  const stem = title
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return stem || 'featured-image';
}

/** The article's own URL as WordPress reports it; its `?p=` short form if that is unusable. */
export function permalink(link: unknown, home: string, id: number): string {
  if (typeof link === 'string') {
    try {
      const url = new URL(link);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
    } catch {
      // Fall through to the short form.
    }
  }
  return `${home.replace(/\/+$/, '')}/?p=${id}`;
}

const STATUS_WORDS: Record<string, string> = {
  draft: 'a draft',
  pending: 'pending review',
  private: 'private',
  future: 'scheduled',
};

/** Said on the event log when "published" here does not mean "public on the site". */
export function statusNotice(actual: string, asked: string): string {
  const state = STATUS_WORDS[actual] ?? `"${actual}"`;
  return actual === asked
    ? `Created on WordPress as ${state}, as asked — it is not public until someone publishes it there.`
    : `WordPress saved this as ${state} instead of "${asked}" — it is not public until someone ` +
        'publishes it there.';
}
