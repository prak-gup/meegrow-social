import { cn } from '../lib/cn';

/** The meegrow·social mark + wordmark. Colours come from tokens via fill/stroke utilities. */
export function Logo({ className, size = 30 }: { className?: string; size?: number }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect width="32" height="32" rx="9" className="fill-canvas stroke-hairline" />
        <path
          d="M8 21 L14 14 L18 17 L24 9"
          className="stroke-rausch"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="24" cy="9" r="2.6" className="fill-ink" />
      </svg>
      <span className="text-wordmark font-bold tracking-tight text-rausch">
        meegrow<span className="text-ink">·social</span>
      </span>
    </span>
  );
}
