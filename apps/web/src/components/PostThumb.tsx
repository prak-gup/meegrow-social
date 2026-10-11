import { useEffect, useState } from 'react';
import { cn } from '../lib/cn';
import { Article, ImageIcon, Images, Play } from '../lib/icons';
import { thumbRetryDelay, type Thumb } from '../lib/postGroups';

const SIZE = {
  /** Calendar entries. */
  xs: 'h-4.5 w-4.5 rounded-xs',
  /** Table rows. */
  sm: 'h-8 w-8 rounded-xs',
  /** Cards. */
  md: 'h-16 w-16 rounded-sm',
  lg: 'h-20 w-20 rounded-sm',
} as const;

export interface PostThumbProps {
  /** From `groupThumb` / `mediaThumb`; null for a text-only post. */
  thumb: Thumb | null;
  /** A text-only post shows its first line here, so the tile still says which post it is. */
  caption?: string;
  size?: keyof typeof SIZE;
  className?: string;
}

/**
 * A post's thumbnail, the same on every screen. A picture when there is one; otherwise a neutral
 * tile that says what is there instead — a play mark for a video with no cover, the first line of
 * the caption for a text-only post. Decorative: the caption beside it is the accessible name.
 * Usage: <PostThumb thumb={groupThumb(group)} caption={group.caption} />
 */
export function PostThumb({ thumb, caption = '', size = 'md', className }: PostThumbProps) {
  // One failed request must not cost the picture for as long as the page stays open: storage
  // answers a burst of new thumbnails with the odd 503, and the same url is fine a second later.
  // So a failure is asked again a few times, and only a url that keeps failing (deleted file,
  // private bucket) falls back to the neutral tile.
  const [load, setLoad] = useState<{ src: string; failures: number; attempt: number } | null>(null);
  const wanted = thumb?.src ?? null;
  const state = load && load.src === wanted ? load : null;
  const failures = state?.failures ?? 0;
  const attempt = state?.attempt ?? 0;
  const retryIn = wanted && failures > attempt ? thumbRetryDelay(attempt) : null;
  useEffect(() => {
    if (!wanted || retryIn === null) return;
    const timer = window.setTimeout(
      () => setLoad({ src: wanted, failures, attempt: attempt + 1 }),
      retryIn,
    );
    return () => window.clearTimeout(timer);
  }, [wanted, retryIn, failures, attempt]);
  const gaveUp = failures > attempt && retryIn === null;
  const roomy = size === 'md' || size === 'lg';
  const icon = size === 'xs' ? 10 : size === 'sm' ? 14 : 20;
  // While a retry is pending the tile stays empty, as it is while the picture first loads.
  const src = wanted && !gaveUp ? wanted : null;
  const waiting = src !== null && failures > attempt;
  const firstLine = caption.split('\n')[0]?.trim() ?? '';

  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative grid flex-none place-items-center overflow-hidden bg-surface-strong text-muted',
        SIZE[size],
        className,
      )}
    >
      {waiting ? null : src ? (
        <img
          // A new element per attempt: the browser asks for the same url again.
          key={attempt}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setLoad({ src, failures: attempt + 1, attempt })}
          className="h-full w-full object-cover"
        />
      ) : thumb?.kind === 'video' ? (
        <Play size={icon} weight="fill" />
      ) : thumb ? (
        <ImageIcon size={icon} />
      ) : roomy && firstLine ? (
        <span className="line-clamp-4 w-full break-words p-1 text-left text-micro leading-tight">
          {firstLine}
        </span>
      ) : (
        <Article size={icon} />
      )}
      {src && !waiting && thumb?.kind === 'video' && size !== 'xs' && (
        <span className="absolute inset-0 grid place-items-center bg-scrim/20 text-white">
          <Play size={size === 'sm' ? 12 : 18} weight="fill" />
        </span>
      )}
      {roomy && thumb && thumb.count > 1 && (
        <span className="tnum absolute bottom-0.5 right-0.5 flex items-center gap-0.5 rounded-xs bg-scrim/60 px-1 text-micro font-medium text-white">
          <Images size={10} />
          {thumb.count}
        </span>
      )}
    </span>
  );
}
