import type { PostView } from '@meegrow-social/contracts';
import type { ChipStatus } from './statusChip';

export const BLOG_PAGE_SIZE = 50;
export const BLOG_STATUSES = [
  { value: 'publish', label: 'Published' },
  { value: 'draft', label: 'Draft on site' },
  { value: 'pending', label: 'Pending' },
  { value: 'future', label: 'Scheduled' },
  { value: 'private', label: 'Private' },
  { value: 'removed', label: 'Removed' },
] as const;

export function blogOptions(post: PostView) {
  return post.options?.kind === 'wordpress' ? post.options : null;
}

/** Only articles already observed on the site; unsent Composer drafts stay in Content. */
export function isSiteArticle(post: PostView): boolean {
  return post.provider === 'wordpress' && post.status === 'published';
}

export function blogTitle(post: PostView): string {
  return blogOptions(post)?.remote?.title || blogOptions(post)?.title || '(Untitled article)';
}

export function blogStatus(post: PostView): string {
  if (post.platformRemovedAt) return 'removed';
  return blogOptions(post)?.remote?.status ?? blogOptions(post)?.status ?? 'publish';
}

export function blogChip(post: PostView): ChipStatus {
  const status = blogStatus(post);
  return status === 'removed'
    ? 'removed'
    : status === 'publish'
      ? 'published'
      : (`site_${status}` as ChipStatus);
}

export function blogStatusLabel(post: PostView): string {
  return BLOG_STATUSES.find((s) => s.value === blogStatus(post))?.label ?? 'Unknown';
}

export function blogSource(post: PostView): string {
  return post.source === 'imported' ? 'Imported' : 'Published here';
}

/** Older app rows retain the terms originally sent; the detail view labels that limitation. */
export function blogTerms(post: PostView, field: 'categories' | 'tags'): string[] {
  const options = blogOptions(post);
  if (options?.remote) return options.remote[field];
  return (options?.[field] ?? []).map((term) =>
    typeof term === 'number' ? `Term ID ${term}` : term,
  );
}

/** Never substitute our dispatch date for an undated site draft. */
export function blogDate(post: PostView, field: 'published' | 'modified'): string | null {
  const remote = blogOptions(post)?.remote;
  return field === 'modified' ? (remote?.modifiedAt ?? null) : remote ? remote.publishedAt : null;
}

export function blogDateLabel(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
}

export interface BlogFilters {
  search: string;
  status: string;
  category: string;
  site: string;
  sort: 'title' | 'published' | 'modified';
  dir: 'asc' | 'desc';
}

export const EMPTY_BLOG_FILTERS: BlogFilters = {
  search: '',
  status: '',
  category: '',
  site: '',
  sort: 'published',
  dir: 'desc',
};

/** Presentation filtering operates on the complete stored inventory, before display pagination. */
export function filterBlog(posts: readonly PostView[], filters: BlogFilters): PostView[] {
  const query = filters.search.trim().toLocaleLowerCase();
  const rows = posts.filter(
    (p) =>
      isSiteArticle(p) &&
      (!query || blogTitle(p).toLocaleLowerCase().includes(query)) &&
      (!filters.status || blogStatus(p) === filters.status) &&
      (!filters.site || p.connectionId === filters.site) &&
      (!filters.category || blogTerms(p, 'categories').includes(filters.category)),
  );
  return rows.sort((a, b) => compareBlog(a, b, filters));
}

export const BLOG_SORT_OPTIONS = [
  { value: 'published:desc', label: 'Newest first' },
  { value: 'published:asc', label: 'Oldest first' },
  { value: 'modified:desc', label: 'Recently modified' },
  { value: 'modified:asc', label: 'Oldest modified' },
  { value: 'title:asc', label: 'Title A–Z' },
  { value: 'title:desc', label: 'Title Z–A' },
];

export function readBlogSort(value: string | null): Pick<BlogFilters, 'sort' | 'dir'> {
  if (!BLOG_SORT_OPTIONS.some((option) => option.value === value))
    return { sort: 'published', dir: 'desc' };
  const [sort, dir] = value!.split(':');
  return { sort: sort as BlogFilters['sort'], dir: dir as BlogFilters['dir'] };
}

/** Publication order uses the site's modification time for drafts, never import time. */
export function blogSortDate(post: PostView, field: 'published' | 'modified'): number | null {
  const draft = ['draft', 'pending'].includes(blogStatus(post));
  const value = field === 'published' && draft ? blogDate(post, 'modified') : blogDate(post, field);
  const fallback =
    field === 'published' && !draft && post.source !== 'imported'
      ? post.publishAt
        ? new Date(post.publishAt).getTime()
        : null
      : null;
  const date = value ? Date.parse(value) : (fallback ?? NaN);
  return Number.isFinite(date) ? date : null;
}

export function compareBlog(
  a: PostView,
  b: PostView,
  filters: Pick<BlogFilters, 'sort' | 'dir'>,
): number {
  const compareDates = (left: number | null, right: number | null, dir: 'asc' | 'desc') => {
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    return dir === 'asc' ? left - right : right - left;
  };
  const primary =
    filters.sort === 'title'
      ? (filters.dir === 'asc' ? 1 : -1) * blogTitle(a).localeCompare(blogTitle(b))
      : compareDates(blogSortDate(a, filters.sort), blogSortDate(b, filters.sort), filters.dir);
  return (
    primary ||
    compareDates(blogSortDate(a, 'published'), blogSortDate(b, 'published'), 'desc') ||
    a.id.localeCompare(b.id)
  );
}

/** Reads only our API, serially; no WordPress traffic. Stop before another page after navigation. */
export async function loadBlogInventory(
  read: (query: {
    provider: string;
    status: string;
    limit: number;
    offset: number;
  }) => Promise<{ posts: PostView[] }>,
  cancelled: () => boolean,
): Promise<PostView[] | null> {
  const posts = new Map<string, PostView>();
  for (let offset = 0; !cancelled(); offset += BLOG_PAGE_SIZE) {
    const page = await read({
      provider: 'wordpress',
      status: 'published',
      limit: BLOG_PAGE_SIZE,
      offset,
    });
    if (cancelled()) return null;
    for (const post of page.posts) if (isSiteArticle(post)) posts.set(post.id, post);
    if (page.posts.length < BLOG_PAGE_SIZE) return [...posts.values()];
  }
  return null;
}

/**
 * Text extraction, NOT an HTML sanitizer. The result must only be used as a React text child.
 * Paragraphs/list items retain simple structure; scripts, images, links and embeds never execute.
 * Unknown entities remain visible. Decoding comes AFTER tag removal, and is never parsed again.
 */
export function articlePreviewText(html: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return html
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<(script|style|iframe|object)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<br\b[^>]*>|<\/(?:p|div|h[1-6]|ul|ol|blockquote|pre|tr)\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole: string, name: string) => {
      if (!name.startsWith('#')) return entities[name.toLowerCase()] ?? whole;
      const n =
        name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
        ? String.fromCodePoint(n)
        : whole;
    })
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
