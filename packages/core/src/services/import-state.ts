import {
  DEFAULT_IMPORT_WINDOW_DAYS,
  type ConnectionImportView,
  type ImportStatus,
} from '@meegrow-social/contracts';
import type {
  ProviderUsage,
  PublishedPostItem,
  PublishedPostPage,
  PublishedPostQuery,
} from '../providers/published-posts.js';
import { ProviderAuthError, ProviderTransientError } from '../errors.js';

/**
 * The rules of "import past posts" that need no database: what is stored about a run, when a
 * connection is due one, how a listed platform post is matched against the posts already stored,
 * and when to stop for the platform's rate limit. `post-import.ts` does the reading and writing.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How far back the import that runs by itself for a newly connected account looks. */
export const IMPORT_BACKFILL_DAYS = DEFAULT_IMPORT_WINDOW_DAYS;
/**
 * Most posts one import reads per connection. A window holding more stops here and says so
 * (`capped`), newest posts kept: the list is read newest first.
 */
export const IMPORT_MAX_POSTS_PER_RUN = 500;
/** Posts asked for per request. Small on purpose: a listing with attachments is a heavy query. */
export const IMPORT_PAGE_SIZE = 25;
/** Pause between two pages of one run, so a backfill is a trickle and not a burst. */
export const IMPORT_PAGE_DELAY_MS = 1_000;
/** Pages one run reads at most before it pauses, whatever the platform keeps offering. */
export const IMPORT_MAX_PAGES_PER_RUN = 40;
/**
 * Reported rate-limit usage at which an import stops and waits. Half, not near-full: publishing
 * runs under the same allowance and must always find room.
 */
export const IMPORT_USAGE_PAUSE_PERCENT = 50;
/** The shortest wait after stopping for the rate limit. */
export const IMPORT_PAUSE_MS = 30 * MINUTE_MS;
/** How often an account is checked for posts made directly on the platform. */
export const IMPORT_SYNC_INTERVAL_MS = 6 * HOUR_MS;
/**
 * How far back each periodic check re-reads. A month, not just "since last time": it is also the
 * window in which a post deleted on the platform is noticed.
 */
export const IMPORT_SYNC_LOOKBACK_DAYS = 30;
/**
 * A listed post younger than this is left for the next run. A post this app is publishing right
 * now is on the platform before its row here carries the platform's id; importing it in that gap
 * would store it twice.
 */
export const IMPORT_SETTLE_MS = 15 * MINUTE_MS;
/** A run that has been `running` this long died with its worker; it is picked up again. */
export const IMPORT_STALE_RUN_MS = 30 * MINUTE_MS;
/** How often the worker looks for connections with an import due. */
export const IMPORT_TICK_INTERVAL_MS = MINUTE_MS;
/** Import runs started per tick, across every workspace. */
export const IMPORT_RUNS_PER_TICK = 2;
/** Most "is it really gone?" reads one run makes. */
export const IMPORT_MAX_REMOVAL_CHECKS = 20;

/** What `connections.import_state` holds: the run in progress, or the last one. */
export interface StoredImportState {
  status: ImportStatus;
  kind: 'backfill' | 'sync';
  windowDays: number;
  /** Oldest publish time this run reads back to. ISO. */
  since: string;
  /**
   * Set once a run has stopped part-way: the oldest publish time read so far, where it continues
   * from. A cursor is never kept — the platform expires them.
   */
  until: string | null;
  /** Stable numeric page/offset for whole-blog transports only (not expiring social cursors). */
  inventoryCursor?: string;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  resumeAt: string | null;
  /** Posts read from the platform so far in this run, across its pauses. */
  seen: number;
  imported: number;
  matched: number;
  removed: number;
  capped: boolean;
  /** True once the run continued after a pause: it no longer holds the whole window's list. */
  resumed: boolean;
  message: string | null;
}

const isStatus = (v: unknown): v is ImportStatus =>
  v === 'queued' || v === 'running' || v === 'paused' || v === 'done' || v === 'failed';

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

/** The stored jsonb as a state, or null when it is absent or not one. Never throws. */
export function parseImportState(value: unknown): StoredImportState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const since = text(v.since);
  const requestedAt = text(v.requestedAt);
  if (!isStatus(v.status) || !since || !requestedAt) return null;
  return {
    status: v.status,
    kind: v.kind === 'sync' ? 'sync' : 'backfill',
    windowDays: count(v.windowDays) || IMPORT_BACKFILL_DAYS,
    since,
    until: text(v.until),
    ...(typeof v.inventoryCursor === 'string' && /^\d+$/.test(v.inventoryCursor)
      ? { inventoryCursor: v.inventoryCursor }
      : {}),
    requestedAt,
    startedAt: text(v.startedAt),
    finishedAt: text(v.finishedAt),
    resumeAt: text(v.resumeAt),
    seen: count(v.seen),
    imported: count(v.imported),
    matched: count(v.matched),
    removed: count(v.removed),
    capped: v.capped === true,
    resumed: v.resumed === true,
    message: text(v.message),
  };
}

/** A run that has been asked for and not started. */
export function queuedImportState(
  now: Date,
  windowDays: number,
  kind: StoredImportState['kind'] = 'backfill',
): StoredImportState {
  return {
    status: 'queued',
    kind,
    windowDays,
    since: new Date(now.getTime() - windowDays * DAY_MS).toISOString(),
    until: null,
    requestedAt: now.toISOString(),
    startedAt: null,
    finishedAt: null,
    resumeAt: null,
    seen: 0,
    imported: 0,
    matched: 0,
    removed: 0,
    capped: false,
    resumed: false,
    message: null,
  };
}

const date = (iso: string | null): Date | null => (iso ? new Date(iso) : null);

export function toImportView(
  state: StoredImportState | null,
  lastImportAt: Date | null,
  supported: boolean,
): ConnectionImportView {
  return {
    supported,
    status: state?.status ?? null,
    kind: state?.kind ?? null,
    windowDays: state?.windowDays ?? null,
    requestedAt: date(state?.requestedAt ?? null),
    startedAt: date(state?.startedAt ?? null),
    finishedAt: date(state?.finishedAt ?? null),
    resumeAt: state?.status === 'paused' ? date(state.resumeAt) : null,
    lastSyncedAt: lastImportAt,
    imported: state?.imported ?? 0,
    matched: state?.matched ?? 0,
    removed: state?.removed ?? 0,
    capped: state?.capped ?? false,
    message: state?.message ?? null,
  };
}

export type ImportDue =
  /** Start the run the state describes (`queued`), or continue it (`paused`, or died mid-run). */
  | { action: 'run'; state: StoredImportState; resumed: boolean }
  /** Nothing was ever imported for this connection: the automatic first backfill. */
  | { action: 'first' }
  /** The periodic look for posts made directly on the platform. */
  | { action: 'sync' };

/**
 * Whether a connection should be imported from now, and how. Pure.
 *
 * A connection that needs reconnecting, has no token, or whose provider cannot list posts is never
 * due. One with no state at all — connected before this existed — gets the same first backfill a
 * new connection is queued for.
 */
export function importDue(
  conn: {
    importState: StoredImportState | null;
    lastImportAt: Date | null;
    needsReconnect: boolean;
    hasToken: boolean;
    supported: boolean;
  },
  now: Date,
): ImportDue | null {
  if (!conn.supported || conn.needsReconnect || !conn.hasToken) return null;
  const state = conn.importState;
  if (!state) return { action: 'first' };
  const t = now.getTime();
  switch (state.status) {
    case 'queued':
      return { action: 'run', state, resumed: false };
    case 'paused':
      return !state.resumeAt || new Date(state.resumeAt).getTime() <= t
        ? { action: 'run', state, resumed: true }
        : null;
    case 'running': {
      const started = state.startedAt ? new Date(state.startedAt).getTime() : 0;
      return t - started >= IMPORT_STALE_RUN_MS ? { action: 'run', state, resumed: true } : null;
    }
    case 'done':
    case 'failed': {
      const last = conn.lastImportAt?.getTime() ?? 0;
      const finished = state.finishedAt ? new Date(state.finishedAt).getTime() : 0;
      if (t - Math.max(last, finished) < IMPORT_SYNC_INTERVAL_MS) return null;
      // A run that failed is asked for again as it was — a backfill that never completed must not
      // quietly shrink to the periodic check's shorter window.
      return state.status === 'failed'
        ? {
            action: 'run',
            state: queuedImportState(now, state.windowDays, state.kind),
            resumed: false,
          }
        : { action: 'sync' };
    }
  }
}

/**
 * Whether to stop reading after a page, and until when. Null = carry on. Stops at
 * `IMPORT_USAGE_PAUSE_PERCENT`, or whenever the platform says it is already throttling; waits at
 * least `IMPORT_PAUSE_MS`, longer if the platform names a longer wait.
 */
export function pauseForUsage(usage: ProviderUsage | null, now: Date): Date | null {
  if (!usage) return null;
  const throttled = (usage.regainAccessMinutes ?? 0) > 0;
  if (!throttled && usage.percent < IMPORT_USAGE_PAUSE_PERCENT) return null;
  const wait = Math.max(IMPORT_PAUSE_MS, (usage.regainAccessMinutes ?? 0) * MINUTE_MS);
  return new Date(now.getTime() + wait);
}

export interface ReadWindowDeps {
  /** One page from the platform. */
  list(query: PublishedPostQuery): Promise<PublishedPostPage>;
  /** Store one page: what was inserted, what was recognised as already stored. */
  apply(
    items: PublishedPostItem[],
  ): Promise<{ imported: number; matched: number; recognised: string[] }>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  wholeHistory?: boolean;
}

export interface ReadWindowResult {
  /** `running` only when `complete`; otherwise `paused` or `failed`, with the reason. */
  state: StoredImportState;
  /** Ids of the stored posts the listed items were recognised as. */
  recognised: Set<string>;
  /** The list was read to its end (or to the post limit). */
  complete: boolean;
  /** The platform refused the credentials: the connection needs reconnecting. */
  authFailed: boolean;
}

/**
 * Read a run's window from the platform page by page — the whole of the rate-limit discipline,
 * with the platform and the database passed in so it can be tested without either.
 *
 * Reads `[state.since, ceiling]` newest first, `IMPORT_PAGE_SIZE` at a time with a pause between
 * pages, and stops when the list ends, at `IMPORT_MAX_POSTS_PER_RUN` posts (`capped`), or — after
 * any page — when the platform's reported usage says to (`pauseForUsage`). Being throttled or
 * hitting a transient error is a pause too, never a failure: the state then says where to continue
 * (`until` = the oldest post read) and when (`resumeAt`). Never throws.
 */
export async function readImportWindow(
  start: StoredImportState,
  ceiling: Date,
  deps: ReadWindowDeps,
): Promise<ReadWindowResult> {
  let state = start;
  const since = new Date(state.since);
  const recognised = new Set<string>();
  let oldest: Date | null = null;

  const paused = (resumeAt: Date, message: string): ReadWindowResult => ({
    state: {
      ...state,
      status: 'paused',
      resumeAt: resumeAt.toISOString(),
      // Continue from the oldest post read; with nothing read, from where this run started.
      until: (oldest ?? ceiling).toISOString(),
      // What a later run reads is no longer the whole window in one piece.
      resumed: true,
      message,
    },
    recognised,
    complete: false,
    authFailed: false,
  });
  const later = () => new Date(deps.now().getTime() + IMPORT_PAUSE_MS);

  try {
    let cursor: string | undefined = deps.wholeHistory ? state.inventoryCursor : undefined;
    for (let page = 0; ; page++) {
      if (page >= IMPORT_MAX_PAGES_PER_RUN) {
        return paused(later(), 'Paused after a long read; it continues by itself.');
      }
      const listed = await deps.list({ since, until: ceiling, cursor, limit: IMPORT_PAGE_SIZE });
      const inWindow = listed.items.filter((i) =>
        deps.wholeHistory
          ? (i.options?.kind === 'wordpress' &&
              (i.options.remote?.status ?? i.options.status) !== 'publish') ||
            i.publishedAt <= ceiling
          : i.publishedAt >= since && i.publishedAt <= ceiling,
      );
      const room = Math.max(IMPORT_MAX_POSTS_PER_RUN - state.seen, 0);
      const taken = inWindow.slice(0, room);
      const applied = await deps.apply(taken);
      for (const id of applied.recognised) recognised.add(id);
      for (const item of taken) {
        if (!oldest || item.publishedAt < oldest) oldest = item.publishedAt;
      }
      state = {
        ...state,
        seen: state.seen + taken.length,
        imported: state.imported + applied.imported,
        matched: state.matched + applied.matched,
        ...(deps.wholeHistory ? { inventoryCursor: listed.nextCursor ?? undefined } : {}),
      };

      // The provider may not honour `since`; a page wholly older than the window ends the read.
      const pastWindow =
        !deps.wholeHistory &&
        listed.items.length > 0 &&
        listed.items.every((i) => i.publishedAt < since);
      const more = Boolean(listed.nextCursor) && !pastWindow;
      if (taken.length < inWindow.length || (state.seen >= IMPORT_MAX_POSTS_PER_RUN && more)) {
        state = {
          ...state,
          capped: true,
          message: `Stopped at ${IMPORT_MAX_POSTS_PER_RUN} posts, the most one import reads. ${deps.wholeHistory ? 'Remaining articles were not imported.' : 'Older posts in this window were not imported.'}`,
        };
        return { state, recognised, complete: true, authFailed: false };
      }
      if (!more) return { state, recognised, complete: true, authFailed: false };

      const resumeAt = pauseForUsage(listed.usage, deps.now());
      if (resumeAt) {
        return paused(
          resumeAt,
          `Paused at ${Math.round(listed.usage?.percent ?? 0)}% of the platform's rate limit, to leave room for publishing. It continues by itself.`,
        );
      }
      cursor = listed.nextCursor ?? undefined;
      await deps.sleep(IMPORT_PAGE_DELAY_MS);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof ProviderAuthError) {
      return {
        state: {
          ...state,
          status: 'failed',
          message: `The platform refused the stored credentials: ${detail}`,
        },
        recognised,
        complete: false,
        authFailed: true,
      };
    }
    if (err instanceof ProviderTransientError) {
      // Throttled, or the platform hiccuped. Not a failure: wait and continue.
      return paused(
        later(),
        `Paused: the platform asked us to slow down (${detail}). It continues by itself.`,
      );
    }
    return {
      state: { ...state, status: 'failed', message: `Import failed: ${detail}` },
      recognised,
      complete: false,
      authFailed: false,
    };
  }
}

/** What the importer needs to know of a post that is already stored. */
export interface KnownPost {
  id: string;
  source: string;
  status: string;
  externalPostId: string | null;
  releaseUrl: string | null;
  publishAt: Date | null;
  caption: string;
  options?: unknown;
  platformRemovedAt: Date | null;
}

export interface PostPatch {
  publishAt?: Date;
  externalPostId?: string;
  caption?: string;
  options?: PublishedPostItem['options'];
  releaseUrl?: string;
  platformRemovedAt?: null;
}

export interface ImportPlan {
  /** Platform posts nobody has stored: each becomes an imported post in a group of its own. */
  inserts: PublishedPostItem[];
  /** Stored posts to bring up to date. Only the fields that differ. */
  patches: Array<{ postId: string; patch: PostPatch }>;
  /** Stored posts a listed item was recognised as, with or without a change. */
  recognised: string[];
  /** How many of those are posts this app published. */
  ownMatched: number;
}

/** The urls a stored post of this item may carry as its link: the permalink and the provider's own. */
const urlsOf = (item: PublishedPostItem): string[] =>
  [item.permalink, ...item.knownUrls].filter((u): u is string => Boolean(u));

/**
 * Match one page of listed platform posts against the posts already stored for the connection.
 * Pure — this is the whole of "never import a post twice, never import our own".
 *
 * A stored post is the listed one when it carries the listed id or one of its alternates, or —
 * for posts stored before the platform's id was kept — the same link. Of several matches the one
 * this app published wins.
 *
 * - No match: insert as imported.
 * - A post this app published: left as it is, except that a missing publish time and a missing
 *   platform id are filled in from the platform. Its caption is never touched: it is what we sent.
 * - A post imported earlier: caption, link and time follow the platform (posts get edited there).
 * - Either way a "removed on platform" mark is cleared: the platform just listed it.
 */
export function planImportPage(
  items: readonly PublishedPostItem[],
  known: readonly KnownPost[],
): ImportPlan {
  const byId = new Map<string, KnownPost[]>();
  const byUrl = new Map<string, KnownPost[]>();
  const index = (map: Map<string, KnownPost[]>, key: string | null, post: KnownPost) => {
    if (key) map.set(key, [...(map.get(key) ?? []), post]);
  };
  for (const post of known) {
    index(byId, post.externalPostId, post);
    index(byUrl, post.releaseUrl, post);
  }

  const plan: ImportPlan = { inserts: [], patches: [], recognised: [], ownMatched: 0 };
  const handled = new Set<string>();
  for (const item of items) {
    // The same post twice on one page (or under an alternate id) is one post.
    if (handled.has(item.externalPostId)) continue;
    handled.add(item.externalPostId);

    const matches = [
      ...[item.externalPostId, ...item.alternateIds].flatMap((id) => byId.get(id) ?? []),
      ...urlsOf(item).flatMap((url) => byUrl.get(url) ?? []),
    ];
    const match = matches.find((p) => p.source !== 'imported') ?? matches[0];
    if (!match) {
      plan.inserts.push(item);
      continue;
    }
    if (plan.recognised.includes(match.id)) continue;
    plan.recognised.push(match.id);

    const patch: PostPatch = {};
    if (match.source === 'imported') {
      if (match.caption !== item.caption) patch.caption = item.caption;
      if (item.options && JSON.stringify(match.options) !== JSON.stringify(item.options))
        patch.options = item.options;
      if (item.permalink && match.releaseUrl !== item.permalink) patch.releaseUrl = item.permalink;
      if (match.publishAt?.getTime() !== item.publishedAt.getTime()) {
        patch.publishAt = item.publishedAt;
      }
    } else {
      plan.ownMatched += 1;
      // Anything but a published post of ours matching a live platform post is not understood;
      // it is recognised (so never duplicated) and otherwise left alone.
      if (match.status !== 'published') continue;
      if (!match.publishAt) patch.publishAt = item.publishedAt;
      if (!match.externalPostId) patch.externalPostId = item.externalPostId;
    }
    if (match.platformRemovedAt) patch.platformRemovedAt = null;
    if (Object.keys(patch).length > 0) plan.patches.push({ postId: match.id, patch });
  }
  return plan;
}

/**
 * Which stored posts to ask the platform about, because a complete read of `[since, until]` did
 * not list them. Pure. Being absent from the list is only a reason to ASK — the list is ranked and
 * filtered by the platform and can leave a live post out — so nothing is marked from this alone.
 *
 * Never a candidate: a post outside the window that was read (it was not looked for), one already
 * marked, one without the platform's id (it cannot be asked about), or one the run recognised.
 * Newest first, at most `limit`.
 */
export function removalCandidates<
  P extends Pick<KnownPost, 'id' | 'externalPostId' | 'publishAt' | 'platformRemovedAt' | 'status'>,
>(
  known: readonly (P & { createdAt: Date })[],
  recognised: ReadonlySet<string>,
  window: { since: Date; until: Date },
  limit = IMPORT_MAX_REMOVAL_CHECKS,
  wholeHistory = false,
): P[] {
  const at = (p: P & { createdAt: Date }) => (p.publishAt ?? p.createdAt).getTime();
  return known
    .filter(
      (p) =>
        p.status === 'published' &&
        p.externalPostId !== null &&
        p.platformRemovedAt === null &&
        !recognised.has(p.id) &&
        (wholeHistory || (at(p) > window.since.getTime() && at(p) < window.until.getTime())),
    )
    .sort((a, b) => at(b) - at(a))
    .slice(0, limit);
}
