import type { PostStatus, PostView } from '@meegrow-social/contracts';
import type { PostGroupStatus } from '@meegrow-social/contracts/group-status';
import { cn } from '../lib/cn';
import {
  CheckCircle,
  CircleNotch,
  Clock,
  DownloadSimple,
  FileDashed,
  Prohibit,
  WarningCircle,
  XCircle,
  type IconComponent,
} from '../lib/icons';
import { platformMeta } from '../lib/platforms';
import { STATUS_LABEL } from '../lib/postStatus';
import { CHIP } from '../lib/statusChip';

/** The dot on a platform icon. Always doubled by words in the title and for screen readers. */
const DOT: Record<PostStatus, string> = {
  draft: 'bg-status-idle',
  scheduled: 'bg-ink',
  publishing: 'bg-ink',
  published: 'bg-status-ok',
  failed: 'bg-status-bad',
  cancelled: 'bg-status-idle',
};

const MAX_ICONS = 4;

export interface PlatformIconsProps {
  /** The variants of one post group. */
  posts: readonly Pick<PostView, 'id' | 'provider' | 'status' | 'connectionId'>[];
  /** Account name per connection id, when known: read out and shown on hover. */
  accounts?: ReadonlyMap<string, string>;
  /** `sm` for calendar entries (no status dot — the entry's own mark carries the status). */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Every platform a post went (or goes) to, as small brand marks, each with a dot for that
 * variant's own status. The hover title and the screen-reader text say it in words:
 * "Instagram · Acme: Published".
 * Usage: <PlatformIcons posts={group.posts} accounts={accountNames} />
 */
export function PlatformIcons({ posts, accounts, size = 'md', className }: PlatformIconsProps) {
  const shown = posts.slice(0, MAX_ICONS);
  const extra = posts.length - shown.length;
  return (
    <span
      className={cn(
        'inline-flex flex-none items-center',
        size === 'md' ? 'gap-1.5' : 'gap-0.5',
        className,
      )}
    >
      {shown.map((p) => {
        const platform = platformMeta({ identifier: p.provider, displayName: p.provider });
        const account = accounts?.get(p.connectionId);
        const words = `${platform.label}${account ? ` · ${account}` : ''}: ${STATUS_LABEL[p.status]}`;
        return (
          <span key={p.id} title={words} className="relative inline-flex flex-none">
            <span
              aria-hidden="true"
              className={cn(
                'grid place-items-center text-white',
                size === 'md' ? 'h-5 w-5 rounded-xs' : 'h-3.5 w-3.5 rounded-xs',
                platform.brand,
              )}
            >
              <platform.Icon size={size === 'md' ? 12 : 9} weight="fill" />
            </span>
            {size === 'md' && (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-canvas',
                  DOT[p.status],
                )}
              />
            )}
            <span className="sr-only">{words}. </span>
          </span>
        );
      })}
      {extra > 0 && (
        <span className="tnum pl-0.5 text-micro font-medium text-muted">
          +{extra}
          <span className="sr-only"> more accounts</span>
        </span>
      )}
    </span>
  );
}

/**
 * The quiet mark of a post that was not published here but found on the platform by an import.
 * A few muted words on a card; just the icon where there is no room (a calendar cell), with the
 * word on hover and for screen readers.
 * Usage: {isImportedGroup(group) && <ImportedMark />}
 */
export function ImportedMark({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      title="Imported from the platform — not published here"
      className={cn('inline-flex flex-none items-center gap-0.5 text-micro text-muted', className)}
    >
      <DownloadSimple size={compact ? 10 : 11} aria-hidden="true" />
      <span className={compact ? 'sr-only' : undefined}>Imported</span>
    </span>
  );
}

const GLYPH: Record<PostGroupStatus, { Icon: IconComponent; className: string; fill?: boolean }> = {
  draft: { Icon: FileDashed, className: 'text-status-idle' },
  scheduled: { Icon: Clock, className: 'text-ink' },
  publishing: { Icon: CircleNotch, className: 'text-ink' },
  published: { Icon: CheckCircle, className: 'text-status-ok', fill: true },
  failed: { Icon: XCircle, className: 'text-status-bad', fill: true },
  partly_failed: { Icon: WarningCircle, className: 'text-status-bad', fill: true },
  cancelled: { Icon: Prohibit, className: 'text-status-idle' },
};

/** Left-edge colour of a calendar entry, by status. */
export const STATUS_EDGE: Record<PostGroupStatus, string> = {
  draft: 'border-l-status-idle',
  scheduled: 'border-l-ink',
  publishing: 'border-l-ink',
  published: 'border-l-status-ok',
  failed: 'border-l-status-bad',
  partly_failed: 'border-l-status-bad',
  cancelled: 'border-l-status-idle',
};

/**
 * A status as a small mark where a chip does not fit (calendar entries). The shape differs per
 * status as well as the colour, and the words are there for screen readers and on hover.
 */
export function StatusGlyph({ status, size = 12 }: { status: PostGroupStatus; size?: number }) {
  const { Icon, className, fill } = GLYPH[status];
  return (
    <span title={CHIP[status].label} className={cn('inline-flex flex-none', className)}>
      <Icon size={size} weight={fill ? 'fill' : 'bold'} aria-hidden="true" />
      <span className="sr-only">{CHIP[status].label}</span>
    </span>
  );
}
