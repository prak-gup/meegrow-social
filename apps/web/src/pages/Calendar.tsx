import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarDay, PostView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { providerVisible } from '../lib/devProviders';
import {
  buildMonthGrid,
  canShiftMonth,
  parseDateKey,
  prepareDays,
  shiftMonth,
  todayKey,
} from '../lib/calendarGrid';
import { cn } from '../lib/cn';
import { platformMeta } from '../lib/platforms';
import { formatPublishTime, postTimeLabel } from '../lib/postDate';
import { replacePost } from '../lib/postList';
import { STATUS_VARIANT, canEditPost } from '../lib/postStatus';
import { EditCaptionModal } from '../components/EditCaptionModal';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { PageHeader } from '../components/ui/PageHeader';
import { CalendarBlank, CaretLeft, CaretRight } from '../lib/icons';

/** Chips shown in a day cell before the rest fold behind "+N more". */
const MAX_CHIPS = 3;

const longDate = (key: string) =>
  parseDateKey(key).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

/**
 * A post on the calendar. A draft or scheduled post is a button that runs the same "Edit" as
 * Content; anything already sent is read-only, so it is not offered as a control.
 */
function PostChip({
  post,
  roomy = false,
  onEdit,
}: {
  post: PostView;
  /** Agenda rows get the platform name and a two-line caption; grid chips stay compact. */
  roomy?: boolean;
  onEdit: (post: PostView) => void;
}) {
  const platform = platformMeta({ identifier: post.provider, displayName: post.provider });
  const time = postTimeLabel(post, formatPublishTime);
  const caption = post.caption || '(no caption)';
  const body = (
    <>
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span
          className={cn(
            'grid h-5 w-5 flex-none place-items-center rounded-xs text-white',
            platform.brand,
          )}
          aria-hidden="true"
        >
          <platform.Icon size={12} weight="fill" />
        </span>
        {roomy && (
          <span className="truncate text-caption font-medium text-ink">{platform.label}</span>
        )}
        <span className="tnum flex-none text-micro font-semibold text-ink">{time}</span>
        <Badge variant={STATUS_VARIANT[post.status]} className="ml-auto px-1.5 py-0 text-micro">
          {post.status}
        </Badge>
      </span>
      <span
        className={cn(
          'w-full text-caption',
          post.caption ? 'text-body-ink' : 'text-muted',
          roomy ? 'line-clamp-2' : 'truncate',
        )}
      >
        {caption}
      </span>
    </>
  );
  const box =
    'flex w-full min-w-0 flex-col gap-1 rounded-xs border border-hairline bg-canvas px-1.5 py-1 text-left';
  if (!canEditPost(post.status)) {
    return (
      <div className={box}>
        <span className="sr-only">{platform.label}, </span>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onEdit(post)}
      aria-label={`Edit caption: ${platform.label}, ${time}, ${post.status}, ${caption}`}
      className={cn(box, 'hover:bg-surface-soft')}
    >
      {body}
    </button>
  );
}

function TodayMark() {
  return <span className="text-micro font-bold uppercase tracking-wide text-rausch">Today</span>;
}

function MonthGrid({
  year,
  month,
  postsByDate,
  expanded,
  onToggle,
  onEdit,
}: {
  year: number;
  month: number;
  postsByDate: Map<string, PostView[]>;
  expanded: ReadonlySet<string>;
  onToggle: (date: string) => void;
  onEdit: (post: PostView) => void;
}) {
  const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const today = todayKey();
  const caption = parseDateKey(`${year}-${String(month).padStart(2, '0')}-01`).toLocaleDateString(
    undefined,
    { month: 'long', year: 'numeric' },
  );
  return (
    // A plain table, not an ARIA grid: every chip and "+N more" is a real button in reading order,
    // so Tab walks the month without promising arrow-key behaviour it does not have.
    <table className="hidden w-full table-fixed border-collapse border border-hairline md:table">
      <caption className="sr-only">Posts in {caption}</caption>
      <thead>
        <tr>
          {(weeks[0] ?? []).map(({ date }) => {
            const d = parseDateKey(date);
            return (
              <th
                key={date}
                scope="col"
                className="border border-hairline bg-surface-soft px-2 py-2 text-left text-caption font-semibold text-muted"
              >
                <span aria-hidden="true">
                  {d.toLocaleDateString(undefined, { weekday: 'short' })}
                </span>
                <span className="sr-only">
                  {d.toLocaleDateString(undefined, { weekday: 'long' })}
                </span>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week) => (
          <tr key={week[0]?.date}>
            {week.map(({ date, day, inMonth }) => {
              const posts = postsByDate.get(date) ?? [];
              const isToday = date === today;
              const open = expanded.has(date);
              const shown = open ? posts : posts.slice(0, MAX_CHIPS);
              const hidden = posts.length - MAX_CHIPS;
              return (
                <td
                  key={date}
                  aria-current={isToday ? 'date' : undefined}
                  className={cn(
                    'h-28 min-w-0 border border-hairline-soft p-1.5 align-top',
                    !inMonth && 'bg-surface-soft',
                    isToday && 'border-2 border-ink',
                  )}
                >
                  <div className="mb-1 flex items-center gap-1.5">
                    <time
                      dateTime={date}
                      aria-label={longDate(date)}
                      className={cn(
                        'tnum grid h-6 min-w-6 place-items-center rounded-full px-1 text-caption',
                        !inMonth && 'text-muted-soft',
                        inMonth && !isToday && 'font-medium text-ink',
                        isToday && 'bg-ink font-bold text-white',
                      )}
                    >
                      {day}
                    </time>
                    {isToday && <TodayMark />}
                  </div>
                  <div className="space-y-1">
                    {shown.map((p) => (
                      <PostChip key={p.id} post={p} onEdit={onEdit} />
                    ))}
                    {hidden > 0 && (
                      <button
                        type="button"
                        onClick={() => onToggle(date)}
                        aria-expanded={open}
                        aria-label={
                          open
                            ? `Show fewer posts on ${longDate(date)}`
                            : `+${hidden} more posts on ${longDate(date)}`
                        }
                        className="w-full rounded-xs px-1.5 py-1 text-left text-caption font-semibold text-ink underline hover:bg-surface-soft"
                      >
                        {open ? 'Show fewer' : `+${hidden} more`}
                      </button>
                    )}
                  </div>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Phone layout: only the days that have posts, in date order. */
function Agenda({ days, onEdit }: { days: CalendarDay[]; onEdit: (post: PostView) => void }) {
  const today = todayKey();
  return (
    <ol className="space-y-4 md:hidden">
      {days.map((day) => (
        <li key={day.date}>
          <h2 className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-ink">
            <time dateTime={day.date}>
              {parseDateKey(day.date).toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })}
            </time>
            {day.date === today && <TodayMark />}
          </h2>
          <ul className="space-y-1.5">
            {day.posts.map((p) => (
              <li key={p.id}>
                <PostChip post={p} roomy onEdit={onEdit} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/** Month view of every post for the active client, bucketed by day in the browser's timezone. */
export function Calendar() {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [days, setDays] = useState<CalendarDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Days whose "+N more" is open; bumping `attempt` re-runs the load (retry).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<PostView | null>(null);
  const [notice, setNotice] = useState('');
  const { year, month } = cursor;

  useEffect(() => {
    // A slow response for a month the operator already left must not overwrite the current one.
    let stale = false;
    setLoading(true);
    setError(null);
    api
      .calendar(year, month, Intl.DateTimeFormat().resolvedOptions().timeZone)
      .then((cal) => {
        // Dev/fake posts stay out of every view in production (lib/devProviders).
        if (!stale) setDays(prepareDays(cal.days, providerVisible));
      })
      .catch((e: unknown) => {
        if (!stale) setError(e instanceof Error ? e.message : 'Please try again.');
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [year, month, attempt]);

  const postsByDate = useMemo(() => new Map(days.map((d) => [d.date, d.posts])), [days]);

  const go = (to: { year: number; month: number }) => {
    setExpanded(new Set());
    setCursor(to);
  };
  const toggle = (date: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(date)) next.add(date);
      return next;
    });
  // Clearing the notice first lets a second save in a row be announced again.
  const edit = useCallback((post: PostView) => {
    setNotice('');
    setEditing(post);
  }, []);
  const closeEdit = useCallback(() => setEditing(null), []);
  // A caption edit cannot move a post to another day, so the saved post is swapped in place: the
  // grid stays mounted and focus returns to the chip that opened the dialog.
  const saved = useCallback((post: PostView) => {
    setDays((prev) => prev.map((d) => ({ ...d, posts: replacePost(d.posts, post) })));
    setEditing(null);
    setNotice('Caption saved.');
  }, []);

  const first = parseDateKey(`${year}-${String(month).padStart(2, '0')}-01`);
  const monthName = first.toLocaleDateString(undefined, { month: 'long' });
  const title = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const now = new Date();

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span aria-live="polite">
            <span className="sr-only">Calendar, </span>
            {title}
          </span>
        }
        subtitle="Scheduled and published posts for this client."
        className="mb-0"
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous month"
              disabled={!canShiftMonth(year, month, -1)}
              onClick={() => go(shiftMonth(year, month, -1))}
            >
              <CaretLeft size={18} />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Next month"
              disabled={!canShiftMonth(year, month, 1)}
              onClick={() => go(shiftMonth(year, month, 1))}
            >
              <CaretRight size={18} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => go({ year: now.getFullYear(), month: now.getMonth() + 1 })}
            >
              Today
            </Button>
          </>
        }
      />

      {loading ? (
        <p role="status" className="text-muted">
          Loading…
        </p>
      ) : error ? (
        <ErrorState
          title="Couldn't load the calendar"
          message={error}
          onRetry={() => setAttempt((a) => a + 1)}
        />
      ) : days.length === 0 ? (
        <EmptyState
          title={`Nothing scheduled in ${monthName}`}
          description="Posts you schedule or publish this month will show up here."
          icon={CalendarBlank}
          action={
            <Button asChild>
              <Link to="/composer">Create post</Link>
            </Button>
          }
        />
      ) : (
        <>
          <MonthGrid
            year={year}
            month={month}
            postsByDate={postsByDate}
            expanded={expanded}
            onToggle={toggle}
            onEdit={edit}
          />
          <Agenda days={days} onEdit={edit} />
        </>
      )}

      {/* Announces a saved caption to screen readers. */}
      <p role="status" className="sr-only">
        {notice}
      </p>
      {editing && <EditCaptionModal post={editing} onSaved={saved} onClose={closeEdit} />}
    </div>
  );
}
