import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge only knows Tailwind's stock font sizes. Without being told, it reads our own
 * `text-caption` / `text-micro` / … (tailwind.config.js `fontSize`) as text COLOURS and drops them
 * whenever a real colour follows — `cn('text-caption', 'text-muted')` came out as just
 * `text-muted`, at the inherited size. Registering them as font sizes keeps both.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'caption', 'body', 'wordmark', 'title'] }],
    },
  },
});

/** Tailwind-aware className combiner (shadcn convention). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
