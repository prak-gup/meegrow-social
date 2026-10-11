import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, max, or, sql } from 'drizzle-orm';
import { db, schema, withWorkspace } from '@meegrow-social/db';
import type {
  AnalyticsStatusView,
  PostLatestMetrics,
  ProviderIdentifier,
} from '@meegrow-social/contracts';
import { getProvider } from '../providers/registry.js';
import type { AuthTokens, MetricPoint } from '../providers/types.js';
import { ProviderAuthError, ProviderRateLimitError } from '../errors.js';
import { decryptToken } from '../crypto.js';
import { ANALYTICS_UPDATED_EVENT, enqueueDeliveriesInTx } from './webhooks.js';
import { systemClock, type Clock } from './queues.js';

/**
 * Analytics collection (issue #9, PRD F5 "collect everything from day 0").
 *
 * Cadence: a freshly published post changes fast and then goes quiet, so it's polled HOURLY for its
 * first 48h, DAILY up to 30 days, WEEKLY up to 90 days and every FOUR WEEKS after that
 * (`POST_POLL_TIERS`); account followers move slowly and are polled DAILY. On top of the cadence
 * each sweep polls at most `POSTS_PER_CONNECTION_PER_SWEEP` posts of one account, newest first —
 * an import can add hundreds of never-polled posts at once, and every post costs one platform call
 * per metric. "Due" is
 * computed from `last_analytics_at` rather than derived from the metrics table on purpose — a post
 * whose provider returns no metrics (every requested name retired, which meta.md §6 says is a live
 * risk) writes no rows, so a derived cutoff would read it as never-swept and re-poll it forever
 * against the platform's rate limits. An explicit column can record "swept, got nothing".
 *
 * Rows are APPENDED, never upserted — the history is the product (follower trend, per-post series).
 * `capturedAt` comes from the provider where it has one.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A post is "fresh" — and polled hourly — for this long after publishing. */
export const FRESH_POST_WINDOW_MS = 48 * HOUR_MS;
/** How often the worker runs the sweep. The finest cadence below, so every due poll is caught. */
export const ANALYTICS_SWEEP_INTERVAL_MS = HOUR_MS;
/** Poll interval of a post inside the fresh window, and of one past it. */
export const FRESH_POST_POLL_INTERVAL_MS = HOUR_MS;
export const POST_POLL_INTERVAL_MS = DAY_MS;
/**
 * How often a post is polled, by its age: the first tier whose `maxAgeMs` the age is under. A
 * lifetime total barely moves once a post is months old, so asking daily only spends rate limit.
 * The last interval stays under the shortest metric retention (YouTube, 30 days), so an old post
 * is never left without a stored row.
 */
export const POST_POLL_TIERS: ReadonlyArray<{ maxAgeMs: number; intervalMs: number }> = [
  { maxAgeMs: FRESH_POST_WINDOW_MS, intervalMs: FRESH_POST_POLL_INTERVAL_MS },
  { maxAgeMs: 30 * DAY_MS, intervalMs: POST_POLL_INTERVAL_MS },
  { maxAgeMs: 90 * DAY_MS, intervalMs: 7 * DAY_MS },
  { maxAgeMs: Infinity, intervalMs: 28 * DAY_MS },
];
/**
 * Most posts of ONE account polled in one sweep. Each costs a platform call per metric (5–6 on
 * Meta), under a limit publishing shares; the rest wait for the next hourly sweep, newest first.
 */
export const POSTS_PER_CONNECTION_PER_SWEEP = 25;

/** The poll interval of a post of this age. */
export function postPollInterval(ageMs: number): number {
  return (POST_POLL_TIERS.find((t) => ageMs < t.maxAgeMs) ?? POST_POLL_TIERS.at(-1)!).intervalMs;
}
/** Poll interval of an account (its followers). */
export const ACCOUNT_POLL_INTERVAL_MS = DAY_MS;

/** Named distinctly from token-health's SweepResult — both are re-exported from the package root. */
export interface AnalyticsSweepResult {
  postsSwept: number;
  accountsSwept: number;
  flagged: number;
  /** Posts that were due but left for a later sweep (over the per-account budget, or throttled). */
  postsDeferred: number;
}

/**
 * Is this post due a poll now? By its age (`POST_POLL_TIERS`). `publishAt` is when it went out; a
 * caller with no publish time passes when the post was created, and null — age unknown — is
 * polled daily, as before the tiers existed.
 */
export function postIsDue(params: {
  publishAt: Date | null;
  lastAnalyticsAt: Date | null;
  now: Date;
}): boolean {
  const { publishAt, lastAnalyticsAt, now } = params;
  if (!lastAnalyticsAt) return true; // never swept
  const interval = publishAt
    ? postPollInterval(now.getTime() - publishAt.getTime())
    : POST_POLL_INTERVAL_MS;
  return now.getTime() - lastAnalyticsAt.getTime() >= interval;
}

/** Accounts move slowly: one poll a day. */
export function accountIsDue(params: { lastAnalyticsAt: Date | null; now: Date }): boolean {
  if (!params.lastAnalyticsAt) return true;
  return params.now.getTime() - params.lastAnalyticsAt.getTime() >= ACCOUNT_POLL_INTERVAL_MS;
}

/**
 * The first instant `postIsDue` turns true for this post — `now` when it has never been swept.
 * The shortest interval after the last poll at whose end the post is still young enough for that
 * interval: a post that leaves the fresh window before its hourly poll comes round is on the daily
 * cadence by then, and so on up the tiers.
 */
export function nextPostDueAt(params: {
  publishAt: Date | null;
  lastAnalyticsAt: Date | null;
  now: Date;
}): Date {
  const { publishAt, lastAnalyticsAt, now } = params;
  if (!lastAnalyticsAt) return now;
  const last = lastAnalyticsAt.getTime();
  if (!publishAt) return new Date(last + POST_POLL_INTERVAL_MS);
  for (const tier of POST_POLL_TIERS) {
    if (last + tier.intervalMs - publishAt.getTime() < tier.maxAgeMs) {
      return new Date(last + tier.intervalMs);
    }
  }
  return new Date(last + POST_POLL_TIERS.at(-1)!.intervalMs);
}

/**
 * Which of the due posts this sweep polls, and how many it leaves. Pure. Newest first — recent
 * posts are the ones whose numbers are still moving and the ones a person looks at — and at most
 * `perConnection` of any one account, so a few hundred posts arriving at once (an import) are
 * worked through over the following sweeps instead of in one burst of calls.
 */
export function selectPostsToSweep<P extends { connectionId: string; publishedAt: Date }>(
  due: readonly P[],
  perConnection = POSTS_PER_CONNECTION_PER_SWEEP,
): { selected: P[]; deferred: number } {
  const taken = new Map<string, number>();
  const selected: P[] = [];
  for (const post of [...due].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())) {
    const n = taken.get(post.connectionId) ?? 0;
    if (n >= perConnection) continue;
    taken.set(post.connectionId, n + 1);
    selected.push(post);
  }
  return { selected, deferred: due.length - selected.length };
}

/** The first instant `accountIsDue` turns true — `now` when the account has never been swept. */
export function nextAccountDueAt(params: { lastAnalyticsAt: Date | null; now: Date }): Date {
  if (!params.lastAnalyticsAt) return params.now;
  return new Date(params.lastAnalyticsAt.getTime() + ACCOUNT_POLL_INTERVAL_MS);
}

/**
 * Null when the connection has no stored token — it cannot be polled, so the sweeper skips it.
 * (`publish.ts` substitutes '' here, which just spends a doomed API call; a sweeper doing that on
 * every pass would burn the platform's rate limit for nothing.)
 */
function tokensFrom(conn: typeof schema.connections.$inferSelect): AuthTokens | null {
  if (!conn.accessToken) return null;
  return {
    accessToken: decryptToken(conn.accessToken),
    refreshToken: conn.refreshToken ? decryptToken(conn.refreshToken) : undefined,
    externalId: conn.externalId,
    displayName: conn.displayName,
  };
}

/**
 * Sweep every workspace. Mirrors the token-health sweeper: enumerate workspaces on the admin handle
 * (`workspaces` is non-tenant), then delegate per-tenant work under `withWorkspace` so RLS isolates.
 */
export async function sweepAnalytics(clock: Clock = systemClock): Promise<AnalyticsSweepResult> {
  const workspaces = await db().select({ id: schema.workspaces.id }).from(schema.workspaces);
  const total: AnalyticsSweepResult = {
    postsSwept: 0,
    accountsSwept: 0,
    flagged: 0,
    postsDeferred: 0,
  };
  for (const ws of workspaces) {
    const r = await sweepAnalyticsForWorkspace(ws.id, clock);
    total.postsSwept += r.postsSwept;
    total.accountsSwept += r.accountsSwept;
    total.flagged += r.flagged;
    total.postsDeferred += r.postsDeferred;
  }
  return total;
}

export async function sweepAnalyticsForWorkspace(
  workspaceId: string,
  clock: Clock = systemClock,
): Promise<AnalyticsSweepResult> {
  const now = clock.now();
  const result: AnalyticsSweepResult = {
    postsSwept: 0,
    accountsSwept: 0,
    flagged: 0,
    postsDeferred: 0,
  };

  await withWorkspace(workspaceId, async (tx) => {
    const connections = await tx.select().from(schema.connections);
    const byId = new Map(connections.map((c) => [c.id, c]));

    // --- posts ---------------------------------------------------------------------------------
    // Only published posts that actually carry the platform's id can be polled, and not one the
    // platform no longer has. Coarse filter here (never swept, or swept over an hour ago);
    // postIsDue() applies the real per-post cadence.
    const candidates = await tx
      .select()
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.status, 'published'),
          isNotNull(schema.posts.externalPostId),
          isNull(schema.posts.platformRemovedAt),
          or(
            isNull(schema.posts.lastAnalyticsAt),
            lt(schema.posts.lastAnalyticsAt, new Date(now.getTime() - HOUR_MS)),
          ),
        ),
      );

    // Due, and on a connection that can answer: a needs_reconnect or tokenless one is skipped
    // rather than spent a doomed call on — and must not use up another account's place either.
    const due = candidates.flatMap((post) => {
      const publishedAt = post.publishAt ?? post.createdAt;
      if (!postIsDue({ publishAt: publishedAt, lastAnalyticsAt: post.lastAnalyticsAt, now })) {
        return [];
      }
      const conn = byId.get(post.connectionId);
      if (!conn || conn.needsReconnect) return [];
      const tokens = tokensFrom(conn);
      return tokens ? [{ ...post, publishedAt, conn, tokens }] : [];
    });
    const { selected, deferred } = selectPostsToSweep(due);
    result.postsDeferred += deferred;
    // Accounts the platform throttled during this sweep: nothing more is asked of them in it.
    const throttled = new Set<string>();

    for (const { conn, tokens, ...post } of selected) {
      if (throttled.has(conn.id)) {
        result.postsDeferred += 1;
        continue;
      }

      try {
        const provider = getProvider(post.provider as ProviderIdentifier);
        const points = await provider.postAnalytics(tokens, post.externalPostId!);
        await appendMetrics(tx, workspaceId, points, { postId: post.id, now });
        // Stamp even when `points` is empty: "we swept and got nothing" is a real, recordable
        // outcome, and without it this post would be re-polled every hour forever.
        await tx
          .update(schema.posts)
          .set({ lastAnalyticsAt: now })
          .where(eq(schema.posts.id, post.id));
        result.postsSwept += 1;
        if (points.length > 0) {
          await enqueueDeliveriesInTx(tx, workspaceId, ANALYTICS_UPDATED_EVENT, {
            postId: post.id,
            provider: post.provider,
            metrics: points.map((p) => ({ metric: p.metric, value: p.value })),
          });
        }
      } catch (err) {
        if (err instanceof ProviderRateLimitError) {
          throttled.add(conn.id);
          result.postsDeferred += 1;
        }
        // One bad account must never kill the sweep — the rest of the workspace still gets polled.
        result.flagged += (await handleSweepError(tx, workspaceId, conn, err)) ? 1 : 0;
      }
    }

    // --- accounts ------------------------------------------------------------------------------
    for (const conn of connections) {
      if (conn.needsReconnect || throttled.has(conn.id)) continue;
      if (!accountIsDue({ lastAnalyticsAt: conn.lastAnalyticsAt, now })) continue;
      const tokens = tokensFrom(conn);
      if (!tokens) continue;

      try {
        const provider = getProvider(conn.provider as ProviderIdentifier);
        const points = await provider.accountAnalytics(tokens);
        await appendMetrics(tx, workspaceId, points, { connectionId: conn.id, now });
        await tx
          .update(schema.connections)
          .set({ lastAnalyticsAt: now })
          .where(eq(schema.connections.id, conn.id));
        result.accountsSwept += 1;
      } catch (err) {
        result.flagged += (await handleSweepError(tx, workspaceId, conn, err)) ? 1 : 0;
      }
    }
  });

  return result;
}

type Tx = Parameters<Parameters<typeof withWorkspace>[1]>[0];

async function appendMetrics(
  tx: Tx,
  workspaceId: string,
  points: MetricPoint[],
  target: { postId?: string; connectionId?: string; now: Date },
): Promise<void> {
  if (points.length === 0) return;
  await tx.insert(schema.metrics).values(
    points.map((p) => ({
      workspaceId,
      postId: target.postId ?? null,
      connectionId: target.connectionId ?? null,
      metric: p.metric,
      value: String(p.value), // numeric column — drizzle takes the decimal as a string
      // Prefer the provider's own timestamp; fall back to sweep time when it doesn't give one.
      capturedAt: p.capturedAt ?? target.now,
    })),
  );
}

/**
 * Auth failure → the connection genuinely needs re-auth: flag it and emit the same event the token
 * sweeper does, atomically with the flag. Anything else is transient (rate limit, upstream blip):
 * log it and leave the connection alone so the next sweep retries. Returns true if flagged.
 * Mirrors the catch-order invariant locked by token-health.
 */
async function handleSweepError(
  tx: Tx,
  workspaceId: string,
  conn: typeof schema.connections.$inferSelect,
  err: unknown,
): Promise<boolean> {
  if (err instanceof ProviderAuthError) {
    await tx
      .update(schema.connections)
      .set({ needsReconnect: true })
      .where(eq(schema.connections.id, conn.id));
    await enqueueDeliveriesInTx(tx, workspaceId, 'connection.needs_reconnect', {
      connectionId: conn.id,
      provider: conn.provider,
      externalId: conn.externalId,
    });
    return true;
  }
  await tx.insert(schema.eventLogs).values({
    workspaceId,
    kind: 'connection',
    platform: conn.provider,
    account: conn.externalId,
    message: `analytics sweep failed: ${err instanceof Error ? err.message : String(err)}`,
  });
  return false;
}

// --- read APIs ---------------------------------------------------------------------------------

export interface MetricRow {
  metric: string;
  value: number;
  capturedAt: Date;
}

/** Full per-post series, oldest first. `latest` is the newest value per metric name. */
export async function getPostMetrics(
  workspaceId: string,
  postId: string,
): Promise<{ latest: Record<string, number>; series: MetricRow[] }> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.metrics)
      .where(eq(schema.metrics.postId, postId))
      .orderBy(asc(schema.metrics.capturedAt));
    const series = rows.map(toMetricRow);
    // Series is ascending, so the last write per name wins — that's the latest value.
    const latest: Record<string, number> = {};
    for (const r of series) latest[r.metric] = r.value;
    return { latest, series };
  });
}

/** Follower trend for one connection, newest first (the dashboard renders most-recent-first). */
export async function getConnectionFollowers(
  workspaceId: string,
  connectionId: string,
): Promise<MetricRow[]> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.metrics)
      .where(
        and(
          eq(schema.metrics.connectionId, connectionId),
          eq(schema.metrics.metric, 'followers'),
          isNull(schema.metrics.postId),
        ),
      )
      .orderBy(desc(schema.metrics.capturedAt));
    return rows.map(toMetricRow);
  });
}

/**
 * Newest value per metric name for many posts in one read (#28). Names are passed through exactly
 * as stored — never renamed, never filtered (BUILD-SPEC-V2 invariant 7).
 *
 * Keyed by post id. An id that is not a post of this workspace gets no entry (RLS hides it, so
 * "another tenant's" and "made up" are the same answer); a post with nothing collected — not swept
 * yet, or its rows pruned by retention — gets an entry with an empty `latest`. Two queries however
 * many ids.
 */
export async function getLatestPostMetrics(
  workspaceId: string,
  postIds: readonly string[],
): Promise<Record<string, PostLatestMetrics>> {
  const wanted = [...new Set(postIds)];
  if (wanted.length === 0) return {};
  return withWorkspace(workspaceId, async (tx) => {
    const posts = await tx
      .select({ id: schema.posts.id })
      .from(schema.posts)
      .where(inArray(schema.posts.id, wanted));
    const out: Record<string, PostLatestMetrics> = {};
    for (const p of posts) out[p.id] = { latest: {}, capturedAt: null };
    if (posts.length === 0) return out;

    // One row per (post, metric): the newest capture, and of two captures at the same instant the
    // one written last.
    const rows = await tx
      .selectDistinctOn([schema.metrics.postId, schema.metrics.metric], {
        postId: schema.metrics.postId,
        metric: schema.metrics.metric,
        value: schema.metrics.value,
        capturedAt: schema.metrics.capturedAt,
      })
      .from(schema.metrics)
      .where(
        inArray(
          schema.metrics.postId,
          posts.map((p) => p.id),
        ),
      )
      .orderBy(
        schema.metrics.postId,
        schema.metrics.metric,
        desc(schema.metrics.capturedAt),
        desc(schema.metrics.createdAt),
      );
    for (const r of rows) {
      const entry = r.postId ? out[r.postId] : undefined;
      if (!entry) continue;
      entry.latest[r.metric] = Number(r.value);
      if (!entry.capturedAt || r.capturedAt > entry.capturedAt) entry.capturedAt = r.capturedAt;
    }
    return out;
  });
}

/** The cadence rules above as data, for a client that wants to state them rather than hardcode them. */
export const ANALYTICS_CADENCE: AnalyticsStatusView['cadence'] = {
  sweepIntervalMs: ANALYTICS_SWEEP_INTERVAL_MS,
  freshPostWindowMs: FRESH_POST_WINDOW_MS,
  freshPostIntervalMs: FRESH_POST_POLL_INTERVAL_MS,
  postIntervalMs: POST_POLL_INTERVAL_MS,
  accountIntervalMs: ACCOUNT_POLL_INTERVAL_MS,
  // The tiers past the daily one: each starts where the tier before it ends.
  olderPosts: POST_POLL_TIERS.slice(2).map((tier, i) => ({
    afterMs: POST_POLL_TIERS[i + 1]!.maxAgeMs,
    intervalMs: tier.intervalMs,
  })),
};

const earliest = (a: Date | null, b: Date | null): Date | null => (!a ? b : !b ? a : a < b ? a : b);
const latest = (a: Date | null, b: Date | null): Date | null => (!a ? b : !b ? a : a > b ? a : b);

/**
 * When this workspace's numbers were last collected, and when the next poll falls due — computed
 * with the same rules the sweep applies (`nextPostDueAt` / `nextAccountDueAt`), over the posts and
 * accounts the sweep would actually poll: a connection that needs reconnecting or has no token is
 * skipped there, so it is left out here too rather than reading "due now" for ever.
 *
 * `nextDueAt` is when something becomes due, not when the sweep runs: the worker polls it on its
 * first tick at or after that time — or a later one while more posts are due than one sweep's
 * budget takes. A fixed number of queries whatever the workspace holds.
 */
export async function getAnalyticsStatus(
  workspaceId: string,
  clock: Clock = systemClock,
): Promise<AnalyticsStatusView> {
  const now = clock.now();
  return withWorkspace(workspaceId, async (tx) => {
    const [captured] = await tx.select({ at: max(schema.metrics.capturedAt) }).from(schema.metrics);
    const [sweptPost] = await tx
      .select({ at: max(schema.posts.lastAnalyticsAt) })
      .from(schema.posts);

    const connections = await tx
      .select({
        id: schema.connections.id,
        lastAnalyticsAt: schema.connections.lastAnalyticsAt,
        needsReconnect: schema.connections.needsReconnect,
        hasToken: sql<boolean>`${schema.connections.accessToken} is not null`,
      })
      .from(schema.connections);
    const pollable = connections.filter((c) => !c.needsReconnect && c.hasToken);

    let lastSweptAt = sweptPost?.at ?? null;
    for (const c of connections) lastSweptAt = latest(lastSweptAt, c.lastAnalyticsAt);

    let nextDueAt: Date | null = null;
    for (const c of pollable) {
      nextDueAt = earliest(
        nextDueAt,
        nextAccountDueAt({ lastAnalyticsAt: c.lastAnalyticsAt, now }),
      );
    }

    if (pollable.length > 0) {
      // Every post the sweep would poll, three timestamps each: with the age tiers there is no
      // single "swept longest ago" row that answers for the rest.
      const posts = await tx
        .select({
          publishAt: schema.posts.publishAt,
          createdAt: schema.posts.createdAt,
          lastAnalyticsAt: schema.posts.lastAnalyticsAt,
        })
        .from(schema.posts)
        .where(
          and(
            eq(schema.posts.status, 'published'),
            isNotNull(schema.posts.externalPostId),
            isNull(schema.posts.platformRemovedAt),
            inArray(
              schema.posts.connectionId,
              pollable.map((c) => c.id),
            ),
          ),
        );
      for (const p of posts) {
        nextDueAt = earliest(
          nextDueAt,
          nextPostDueAt({
            publishAt: p.publishAt ?? p.createdAt,
            lastAnalyticsAt: p.lastAnalyticsAt,
            now,
          }),
        );
      }
    }

    return {
      lastCapturedAt: captured?.at ?? null,
      lastSweptAt,
      nextDueAt,
      cadence: ANALYTICS_CADENCE,
    };
  });
}

function toMetricRow(r: typeof schema.metrics.$inferSelect): MetricRow {
  return { metric: r.metric, value: Number(r.value), capturedAt: r.capturedAt };
}
