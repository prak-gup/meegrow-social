import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import {
  ENGAGEMENT_RATE_FORMULA,
  basisText,
  compact,
  formatNumber,
  formatRate,
  rateNote,
  type Report,
} from '../../lib/analyticsReport';
import { ArrowSquareOut, Trophy, Warning } from '../../lib/icons';
import { captionSnippet, safeExternalUrl } from '../../lib/postList';
import { PostThumb } from '../PostThumb';
import { Skeleton } from '../ui/Skeleton';
import { StatTile } from '../ui/StatTile';
import { platformLabel } from './parts';

// One cell of the strip: StatTile without its own frame, divided from its neighbours by hairlines.
// The grid's -1px margins hide the dividers on the strip's right and bottom edges.
const CELL = 'rounded-none border-0 border-b border-r border-hairline-soft';
const TOTAL_HINT =
  'Added up over the posts published in the period, each at its all-time count as of its last capture.';

/**
 * The headline numbers as one strip: engagement rate, reach, views, followers, posts — each against
 * the period before — and the best post. Under it, the engagement-rate formula in words, and a
 * warning whenever the rate mixes two denominators.
 */
export function Kpis({ report, periodText }: { report: Report; periodText: string }) {
  const { summary } = report;
  const rate = summary.engagementRate;
  const basis = basisText(rate);
  const followers = summary.followers;
  const followersHint =
    followers.accountsCounted < followers.accounts
      ? `Latest capture in the period, from ${followers.accountsCounted} of ${followers.accounts} accounts — the others have no follower capture in it.`
      : 'Latest capture in the period, added up over the selected accounts.';
  return (
    <section aria-label="Totals" className="space-y-1.5">
      <div className="overflow-hidden rounded-md border border-hairline bg-canvas">
        <div className="-mb-px -mr-px grid grid-cols-2 sm:grid-cols-kpis">
          <StatTile
            className={CELL}
            label="Engagement rate"
            value={
              <>
                {formatRate(rate.rate)}
                {basis && rate.basis !== 'mixed' && (
                  <span className="ml-1.5 text-caption font-normal text-muted">{basis}</span>
                )}
              </>
            }
            delta={summary.engagementRateDeltaPct}
            showMissingDelta
            hint={`${ENGAGEMENT_RATE_FORMULA} ${rateNote(rate)}`}
          />
          <StatTile
            className={CELL}
            label="Reach"
            value={
              <span title={formatNumber(summary.totals.reach.value)}>
                {compact(summary.totals.reach.value)}
              </span>
            }
            delta={summary.totals.reach.deltaPct}
            showMissingDelta
            hint={`${TOTAL_HINT} Someone reached by two posts is counted twice.`}
          />
          <StatTile
            className={CELL}
            label="Views"
            value={
              <span title={formatNumber(summary.totals.views.value)}>
                {compact(summary.totals.views.value)}
              </span>
            }
            delta={summary.totals.views.deltaPct}
            showMissingDelta
            hint={TOTAL_HINT}
          />
          <StatTile
            className={CELL}
            label="Followers"
            value={<span title={formatNumber(followers.value)}>{compact(followers.value)}</span>}
            delta={followers.deltaPct}
            deltaLabel={
              followers.change === null
                ? 'vs prior'
                : `(${followers.change >= 0 ? '+' : '−'}${Math.abs(followers.change).toLocaleString()}) vs prior`
            }
            showMissingDelta
            hint={followersHint}
          />
          <StatTile
            className={CELL}
            label="Posts"
            value={formatNumber(summary.posts.value)}
            delta={summary.posts.deltaPct}
            showMissingDelta
            hint="Posts published in the period."
          />
          <BestPost best={summary.bestPost} className={CELL} />
        </div>
      </div>
      {/* The definitions are also on hover, but hover alone is not reachable by keyboard or touch. */}
      <p className="text-caption text-muted">
        {ENGAGEMENT_RATE_FORMULA} {rateNote(rate)} Changes compare with {periodText}. Totals add up
        the all-time counts of the posts published in the period.
      </p>
      {rate.basis === 'mixed' && (
        <p className="flex items-start gap-1.5 text-caption font-semibold text-status-warn">
          <Warning size={14} weight="fill" aria-hidden="true" className="mt-px flex-none" />
          <span>
            This rate mixes two denominators — {rate.byReach.toLocaleString()}{' '}
            {rate.byReach === 1 ? 'post is' : 'posts are'} divided by reach and{' '}
            {rate.byViews.toLocaleString()} by views — so it is not comparable with a rate that is
            reach-only. The platform table below shows each platform on its own basis.
          </span>
        </p>
      )}
    </section>
  );
}

/** The period's best post, linking to it on the platform. */
function BestPost({
  best,
  className,
}: {
  best: Report['summary']['bestPost'];
  className?: string;
}) {
  const row = 'mt-1 flex min-w-0 items-center gap-2.5 rounded-sm';
  const by = best?.by === 'views' ? 'views' : 'engagements';
  const url = best ? safeExternalUrl(best.post.releaseUrl) : null;
  const body = best && (
    <>
      <PostThumb
        thumb={
          best.post.format === 'text'
            ? null
            : { kind: best.post.format, src: safeExternalUrl(best.post.thumbnailUrl), count: 1 }
        }
        caption={best.post.caption}
        size="sm"
        className="h-10 w-10"
      />
      <span className="min-w-0 flex-1">
        <span className="tnum block text-lg font-semibold leading-tight text-ink">
          {formatNumber(best.value)}{' '}
          <span className="text-caption font-normal text-muted">{by}</span>
        </span>
        <span className="block truncate text-caption text-muted">
          {captionSnippet(best.post.caption, 60)}
        </span>
      </span>
    </>
  );
  return (
    <div className={cn('col-span-2 min-w-0 bg-canvas p-3', className)}>
      <div className="flex items-center justify-between gap-2 text-caption font-medium text-muted">
        <span>Best post</span>
        <Trophy size={16} className="flex-none" aria-hidden="true" />
      </div>
      {!best ? (
        <p className="mt-1 text-sm text-muted">
          <span aria-hidden="true">— </span>No post in this period reports engagements or views.
        </p>
      ) : url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Best post, ${formatNumber(best.value)} ${by}: ${captionSnippet(best.post.caption)} (opens on ${platformLabel(best.post.provider)} in a new tab)`}
          className={cn(row, 'hover:bg-surface-soft')}
        >
          {body}
          <ArrowSquareOut size={14} className="flex-none text-muted" aria-hidden="true" />
        </a>
      ) : (
        // No link to the platform was stored for this post, so it opens where it can be found.
        <Link
          to="/content"
          aria-label={`Best post, ${formatNumber(best.value)} ${by}: ${captionSnippet(best.post.caption)}. Open Content`}
          className={cn(row, 'hover:bg-surface-soft')}
        >
          {body}
        </Link>
      )}
    </div>
  );
}

/** Same strip geometry as the loaded numbers, so nothing jumps when they arrive. */
export function KpiSkeleton() {
  return (
    <div className="space-y-1.5" aria-hidden="true">
      <div className="overflow-hidden rounded-md border border-hairline bg-canvas">
        <div className="-mb-px -mr-px grid grid-cols-2 sm:grid-cols-kpis">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className={cn('p-3', CELL)}>
              <Skeleton className="h-4 w-20" />
              <Skeleton className="mt-1.5 h-7 w-16" />
              <Skeleton className="mt-1.5 h-4 w-24" />
            </div>
          ))}
          <div className={cn('col-span-2 p-3', CELL)}>
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-1.5 h-10 w-full" />
          </div>
        </div>
      </div>
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
