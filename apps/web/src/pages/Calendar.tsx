import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
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
import { formatPublishTime } from '../lib/postDate';
import {
  SOURCES,
  dayEntries,
  filterBySource,
  groupChip,
  groupThumb,
  isImportedGroup,
  mergePosts,
  type CalendarEntry,
  type SourceKey,
} from '../lib/postGroups';
import { importingNote } from '../lib/postImport';
import { captionSnippet, writeViewMode, type ViewMode } from '../lib/postList';
import { CHIP } from '../lib/statusChip';
import { ImportedMark, PlatformIcons, STATUS_EDGE, StatusGlyph } from '../components/PostMarks';
import { usePostGroupActions, type PostChange } from '../components/PostGroupActions';
import { PostThumb } from '../components/PostThumb';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FilterSelect, ViewToggle } from '../components/ui/FilterBar';
import { PageHeader } from '../components/ui/PageHeader';
import { RowMenu, type RowMenuItem } from '../components/ui/RowMenu';
import { StatusChip } from '../components/ui/StatusChip';
import { CalendarBlank, CaretLeft, CaretRight, CloseIcon, Rows, SquaresFour } from '../lib/icons';

/** Entries shown in a day cell before the rest fold behind "+N more". */
const MAX_ENTRIES = 3;
const MENU_WIDTH = 232;
const POPOVER_WIDTH = 288;

const longDate = (key: string) =>
  parseDateKey(key).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

type ItemsFor = (entry: CalendarEntry) => RowMenuItem[];

interface EntryProps {
  entry: CalendarEntry;
  accounts: ReadonlyMap<string, string>;
  items: ItemsFor;
}

const entryTime = (entry: CalendarEntry) => formatPublishTime(new Date(entry.at));

/** What a screen reader hears for an entry: time, status, where it goes, and the caption. */
const entryLabel = (entry: CalendarEntry) =>
  `Actions for post at ${entryTime(entry)}, ${CHIP[groupChip(entry)].label}${
    isImportedGroup(entry) ? ', imported' : ''
  }: ${captionSnippet(entry.caption)}`;

/**
 * A post on the month grid: one line — status mark, time, thumbnail, platforms, the caption's
 * start — with its status also on the left edge. The whole entry is the button that opens the same
 * actions the post has on Content.
 */
function CompactEntry({ entry, accounts, items }: EntryProps) {
  return (
    <RowMenu
      label={entryLabel(entry)}
      items={items(entry)}
      align="start"
      width={MENU_WIDTH}
      className={cn(
        'flex h-6 w-full min-w-0 items-center gap-1 rounded-xs border border-l-2 border-hairline-soft bg-canvas px-1 text-left hover:bg-surface-soft',
        STATUS_EDGE[entry.status],
        entry.status === 'cancelled' && 'opacity-70',
      )}
    >
      <StatusGlyph status={entry.status} />
      <span className="tnum flex-none text-micro font-semibold text-ink">{entryTime(entry)}</span>
      <PostThumb thumb={groupThumb(entry)} size="xs" />
      <PlatformIcons posts={entry.posts} accounts={accounts} size="sm" />
      {isImportedGroup(entry) && <ImportedMark compact />}
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-micro',
          entry.caption ? 'text-body-ink' : 'text-muted',
        )}
      >
        {entry.caption || '(no caption)'}
      </span>
    </RowMenu>
  );
}

/** The same entry with room to breathe: the agenda on a phone, and the "+N more" list. */
function RoomyEntry({ entry, accounts, items }: EntryProps) {
  return (
    <RowMenu
      label={entryLabel(entry)}
      items={items(entry)}
      align="start"
      width={MENU_WIDTH}
      className={cn(
        'flex w-full min-w-0 items-center gap-2.5 rounded-sm border border-l-2 border-hairline bg-canvas p-2 text-left hover:bg-surface-soft',
        STATUS_EDGE[entry.status],
      )}
    >
      <PostThumb
        thumb={groupThumb(entry)}
        caption={entry.caption}
        size="sm"
        className="h-10 w-10"
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="tnum flex-none text-caption font-semibold text-ink">
            {entryTime(entry)}
          </span>
          <PlatformIcons posts={entry.posts} accounts={accounts} />
          {isImportedGroup(entry) && <ImportedMark />}
          <StatusChip status={groupChip(entry)} className="ml-auto" />
        </span>
        <span
          className={cn(
            'mt-0.5 line-clamp-2 break-words text-caption',
            entry.caption ? 'text-body-ink' : 'text-muted',
          )}
        >
          {entry.caption || '(no caption)'}
        </span>
      </span>
    </RowMenu>
  );
}

/**
 * Every post of a day that did not fit its cell, in a popover anchored to the "+N more" button.
 * Fixed in a portal so the table can never clip it. Focus moves in on open; Escape, Tab past the
 * end, or a click outside closes it and Escape returns focus to the button. A click in an entry's
 * own menu or in a dialog opened from it is not "outside".
 */
function DayPopover({
  date,
  entries,
  anchor,
  onClose,
  ...entryProps
}: {
  date: string;
  entries: CalendarEntry[];
  anchor: HTMLElement;
  onClose: (restoreFocus: boolean) => void;
} & Omit<EntryProps, 'entry'>) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 8));
    const below = r.bottom + 4;
    // Opens downward; above the button when there is no room below and there is above.
    const top =
      below + height > window.innerHeight - 8 && r.top - height - 4 > 8
        ? r.top - height - 4
        : below;
    setPos({ top, left });
  }, [anchor, entries.length]);

  useEffect(() => {
    if (pos) ref.current?.querySelector<HTMLElement>('button')?.focus();
    // Keyed on "has a position", so a later re-placement does not steal focus from an open menu.
  }, [pos === null]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      if (t.closest?.('[role="menu"], [aria-modal="true"]')) return;
      onClose(false);
    };
    const onResize = () => onClose(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose(true);
      return;
    }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the popover: it is a small dialog, and the page behind it is still there.
    const focusables = Array.from(ref.current?.querySelectorAll<HTMLElement>('button') ?? []);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Posts on ${longDate(date)}`}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        width: POPOVER_WIDTH,
        visibility: pos ? 'visible' : 'hidden',
        ...pos,
      }}
      className="z-40 max-h-96 overflow-y-auto rounded-md border border-hairline bg-canvas p-2 shadow-1"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2 pl-1">
        <p className="text-sm font-semibold text-ink">
          {parseDateKey(date).toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          })}
          <span className="tnum ml-1.5 font-normal text-muted">{entries.length} posts</span>
        </p>
        <button
          type="button"
          onClick={() => onClose(true)}
          aria-label="Close"
          className="grid h-7 w-7 flex-none place-items-center rounded-sm text-muted hover:bg-surface-strong hover:text-ink"
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <ul className="space-y-1.5">
        {entries.map((entry) => (
          <li key={entry.id}>
            <RoomyEntry entry={entry} {...entryProps} />
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}

function TodayMark() {
  return <span className="text-micro font-bold uppercase tracking-wide text-rausch">Today</span>;
}

function MonthGrid({
  year,
  month,
  entriesByDate,
  ...entryProps
}: {
  year: number;
  month: number;
  entriesByDate: Map<string, CalendarEntry[]>;
} & Omit<EntryProps, 'entry'>) {
  const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const [open, setOpen] = useState<{ date: string; anchor: HTMLElement } | null>(null);
  const closePopover = useCallback((restoreFocus: boolean) => {
    setOpen((current) => {
      if (restoreFocus) current?.anchor.focus();
      return null;
    });
  }, []);
  const today = todayKey();
  const caption = parseDateKey(`${year}-${String(month).padStart(2, '0')}-01`).toLocaleDateString(
    undefined,
    { month: 'long', year: 'numeric' },
  );
  const openEntries = open ? (entriesByDate.get(open.date) ?? []) : [];
  return (
    <>
      {/* A plain table, not an ARIA grid: every entry and "+N more" is a real button in reading
          order, so Tab walks the month without promising arrow-key behaviour it does not have. */}
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
                  className="border border-hairline bg-surface-soft px-2 py-1.5 text-left text-caption font-medium text-muted"
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
                const entries = entriesByDate.get(date) ?? [];
                const isToday = date === today;
                const hidden = entries.length - MAX_ENTRIES;
                return (
                  <td
                    key={date}
                    aria-current={isToday ? 'date' : undefined}
                    className={cn(
                      'h-28 min-w-0 border border-hairline-soft p-1 align-top',
                      !inMonth && 'bg-surface-soft',
                      isToday && 'border-2 border-ink',
                    )}
                  >
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <time
                        dateTime={date}
                        aria-label={longDate(date)}
                        className={cn(
                          'tnum grid h-5 min-w-5 place-items-center rounded-full px-1 text-caption',
                          !inMonth && 'text-muted-soft',
                          inMonth && !isToday && 'font-medium text-ink',
                          isToday && 'bg-ink font-bold text-white',
                        )}
                      >
                        {day}
                      </time>
                      {isToday && <TodayMark />}
                    </div>
                    <div className="space-y-0.5">
                      {entries.slice(0, MAX_ENTRIES).map((entry) => (
                        <CompactEntry key={entry.id} entry={entry} {...entryProps} />
                      ))}
                      {hidden > 0 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            const anchor = e.currentTarget;
                            setOpen((current) =>
                              current?.date === date ? null : { date, anchor },
                            );
                          }}
                          aria-haspopup="dialog"
                          aria-expanded={open?.date === date}
                          aria-label={`All ${entries.length} posts on ${longDate(date)}`}
                          className="w-full rounded-xs px-1 text-left text-micro font-semibold text-ink underline hover:bg-surface-soft"
                        >
                          +{hidden} more
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
      {open && openEntries.length > 0 && (
        <DayPopover
          date={open.date}
          entries={openEntries}
          anchor={open.anchor}
          onClose={closePopover}
          {...entryProps}
        />
      )}
    </>
  );
}

/** Phone layout: only the days that have posts, in date order. */
function Agenda({
  days,
  ...entryProps
}: { days: Array<{ date: string; entries: CalendarEntry[] }> } & Omit<EntryProps, 'entry'>) {
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
            {day.entries.map((entry) => (
              <li key={entry.id}>
                <RoomyEntry entry={entry} {...entryProps} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/**
 * Month view of every post for the active client, bucketed by day in the browser's timezone. One
 * entry per composed post: a day's posts are grouped here (lib/postGroups `dayEntries`), which is
 * safe because the calendar API returns the whole month at once.
 */
export function Calendar() {
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [days, setDays] = useState<CalendarDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumping `attempt` re-runs the load (retry, or a post moved to another day).
  const [attempt, setAttempt] = useState(0);
  const [accounts, setAccounts] = useState<ReadonlyMap<string, string>>(new Map());
  // Whole months arrive at once, so the source filter is applied here rather than asked of the API.
  const [source, setSource] = useState<SourceKey>('');
  const [importing, setImporting] = useState<string | null>(null);
  const { year, month } = cursor;
  // A reload after a change keeps the grid on screen; only a first load or a new month blanks it.
  const shownKey = useRef('');

  useEffect(() => {
    // A slow response for a month the operator already left must not overwrite the current one.
    let stale = false;
    const key = `${year}-${month}`;
    if (shownKey.current !== key) setLoading(true);
    setError(null);
    api
      .calendar(year, month, Intl.DateTimeFormat().resolvedOptions().timeZone)
      .then((cal) => {
        // Dev/fake posts stay out of every view in production (lib/devProviders).
        if (stale) return;
        setDays(prepareDays(cal.days, providerVisible));
        shownKey.current = key;
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

  // The composer panel sits over this page without unmounting it; when it closes after creating a
  // post it says so in router state, and the month is read again.
  const refreshed = (useLocation().state as { refreshed?: number } | null)?.refreshed;
  useEffect(() => {
    if (refreshed) setAttempt((a) => a + 1);
  }, [refreshed]);

  // Account names for hover titles and dialogs. Without them the entries just show the platform.
  useEffect(() => {
    void api
      .listConnections()
      .then((res) => {
        setAccounts(new Map(res.connections.map((c) => [c.id, c.displayName])));
        setImporting(importingNote(res.connections.filter((c) => providerVisible(c.provider))));
      })
      .catch(() => setAccounts(new Map()));
  }, []);

  const entryDays = useMemo(
    () =>
      days
        .map((d) => ({ date: d.date, entries: dayEntries(filterBySource(d.posts, source)) }))
        .filter((d) => d.entries.length > 0),
    [days, source],
  );
  const entriesByDate = useMemo(
    () => new Map(entryDays.map((d) => [d.date, d.entries])),
    [entryDays],
  );

  const onChanged = useCallback((posts: PostView[], change: PostChange) => {
    // A caption edit, a cancel or a retry cannot move a post to another day, so the variants are
    // swapped in place: the grid stays mounted and focus returns to the entry that opened the
    // dialog. A new time can move it to another day or month, which only the API can bucket.
    if (change === 'time') {
      setAttempt((a) => a + 1);
      return;
    }
    setDays((prev) => prev.map((d) => ({ ...d, posts: mergePosts(d.posts, posts) })));
  }, []);
  // A copy is a draft with no date, so it is not on the calendar: say where it went.
  const onDuplicated = useCallback(() => undefined, []);
  const actions = usePostGroupActions({ accounts, onChanged, onDuplicated });
  const entryProps = { accounts, items: actions.items };

  const go = (to: { year: number; month: number }) => {
    actions.clearMessages();
    setCursor(to);
  };
  const chooseView = (mode: string) => {
    if (mode === 'calendar') return;
    writeViewMode(mode as ViewMode);
    navigate('/content');
  };

  const first = parseDateKey(`${year}-${String(month).padStart(2, '0')}-01`);
  const monthName = first.toLocaleDateString(undefined, { month: 'long' });
  const title = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const now = new Date();
  const duplicated = actions.notice.startsWith('Duplicated');

  return (
    <div>
      <PageHeader
        title={
          <span aria-live="polite">
            <span className="sr-only">Calendar, </span>
            {title}
          </span>
        }
        subtitle="Scheduled and published posts for this client."
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous month"
              disabled={!canShiftMonth(year, month, -1)}
              onClick={() => go(shiftMonth(year, month, -1))}
            >
              <CaretLeft size={16} />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Next month"
              disabled={!canShiftMonth(year, month, 1)}
              onClick={() => go(shiftMonth(year, month, 1))}
            >
              <CaretRight size={16} />
            </Button>
            <Button
              variant="outline"
              onClick={() => go({ year: now.getFullYear(), month: now.getMonth() + 1 })}
            >
              Today
            </Button>
            <FilterSelect
              label="Source"
              value={source}
              onChange={(v) => setSource(v as SourceKey)}
              options={SOURCES.map((s) => ({ value: s.value, label: s.label }))}
            />
            <ViewToggle
              label="View"
              value="calendar"
              onChange={chooseView}
              options={[
                { value: 'grid', label: 'Grid', icon: <SquaresFour size={16} /> },
                { value: 'list', label: 'List', icon: <Rows size={16} /> },
                { value: 'calendar', label: 'Calendar', icon: <CalendarBlank size={16} /> },
              ]}
            />
          </>
        }
      />

      {/* Results of actions are shown, not only announced: a duplicate is a draft, off the calendar. */}
      <p
        role="status"
        className={cn('text-caption text-muted', actions.notice ? 'mb-2' : 'sr-only')}
      >
        {actions.notice}
        {duplicated && (
          <>
            {' '}
            <Link to="/content" className="font-semibold text-ink underline">
              See it in Content
            </Link>
          </>
        )}
      </p>
      {actions.error && (
        <p role="alert" className="mb-2 text-sm text-error">
          {actions.error}
        </p>
      )}

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
      ) : days.length > 0 && entryDays.length === 0 ? (
        <EmptyState
          title={`No ${source === 'imported' ? 'imported posts' : 'posts published here'} in ${monthName}`}
          description="This month has posts from the other source."
          icon={CalendarBlank}
          action={
            <Button variant="outline" onClick={() => setSource('')}>
              Show all sources
            </Button>
          }
        />
      ) : days.length === 0 ? (
        <EmptyState
          title={importing ? 'Importing past posts…' : `Nothing scheduled in ${monthName}`}
          description={importing ?? 'Posts you schedule or publish this month will show up here.'}
          icon={CalendarBlank}
          action={
            <Button asChild>
              <Link to="/composer" state={{ background: '/calendar' }}>
                Create post
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <MonthGrid year={year} month={month} entriesByDate={entriesByDate} {...entryProps} />
          <Agenda days={entryDays} {...entryProps} />
        </>
      )}

      {actions.dialogs}
    </div>
  );
}
