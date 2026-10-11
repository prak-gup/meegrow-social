import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  or,
  sql,
} from 'drizzle-orm';
import { db, schema, withWorkspace } from '@meegrow-social/db';
import type {
  AnalyticsStatusView,
  PostLatestMetrics,
  ProviderIdentifier,
} from '@meegrow-social/contracts';
import { getProvider } from '../providers/registry.js';
import type { AuthTokens, MetricPoint } from '../providers/types.js';
import { ProviderAuthError } from '../errors.js';
import { decryptToken } from '../crypto.js';
import { ANALYTICS_UPDATED_EVENT, enqueueDeliveriesInTx } from './webhooks.js';
import { systemClock, type Clock } from './queues.js';

/**
 * Analytics collection (issue #9, PRD F5 "collect everything from day 0").
 *
 * Cadence: a freshly published post changes fast and then goes quiet, so it's polled HOURLY for its
 * first 48h and DAILY after that; account followers move slowly and are polled DAILY. "Due" is
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
/** Poll interval of an account (its followers). */
export const ACCOUNT_POLL_INTERVAL_MS = DAY_MS;

/** Named distinctly from token-health's SweepResult — both are re-exported from the package root. */
export interface AnalyticsSweepResult {
  postsSwept: number;
  accountsSwept: number;
  flagged: number;
}

/** Is this post due a poll now? Hourly while fresh, daily once it's older than the fresh window. */
export function postIsDue(params: {
  publishAt: Date | null;
  lastAnalyticsAt: Date | null;
  now: Date;
}): boolean {
  const { publishAt, lastAnalyticsAt, now } = params;
  if (!lastAnalyticsAt) return true; // never swept
  const age = publishAt ? now.getTime() - publishAt.getTime() : Infinity;
  const interval = age < FRESH_POST_WINDOW_MS ? FRESH_POST_POLL_INTERVAL_MS : POST_POLL_INTERVAL_MS;
  return now.getTime() - lastAnalyticsAt.getTime() >= interval;
}

/** Accounts move slowly: one poll a day. */
export function accountIsDue(params: { lastAnalyticsAt: Date | null; now: Date }): boolean {
  if (!params.lastAnalyticsAt) return true;
  return params.now.getTime() - params.lastAnalyticsAt.getTime() >= ACCOUNT_POLL_INTERVAL_MS;
}

/**
 * The first instant `postIsDue` turns true for this post — `now` when it has never been swept.
 * An hour after the last poll if the post is still fresh at that moment; otherwise a day after,
 * because a post that leaves the fresh window before its hourly poll comes round is on the daily
 * cadence by then.
 */
export function nextPostDueAt(params: {
  publishAt: Date | null;
  lastAnalyticsAt: Date | null;
  now: Date;
}): Date {
  const { publishAt, lastAnalyticsAt, now } = params;
  if (!lastAnalyticsAt) return now;
  const hourly = lastAnalyticsAt.getTime() + FRESH_POST_POLL_INTERVAL_MS;
  if (publishAt && hourly - publishAt.getTime() < FRESH_POST_WINDOW_MS) return new Date(hourly);
  return new Date(lastAnalyticsAt.getTime() + POST_POLL_INTERVAL_MS);
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
  const total: AnalyticsSweepResult = { postsSwept: 0, accountsSwept: 0, flagged: 0 };
  for (const ws of workspaces) {
    const r = await sweepAnalyticsForWorkspace(ws.id, clock);
    total.postsSwept += r.postsSwept;
    total.accountsSwept += r.accountsSwept;
    total.flagged += r.flagged;
  }
  return total;
}

export async function sweepAnalyticsForWorkspace(
  workspaceId: string,
  clock: Clock = systemClock,
): Promise<AnalyticsSweepResult> {
  const now = clock.now();
  const result: AnalyticsSweepResult = { postsSwept: 0, accountsSwept: 0, flagged: 0 };

  await withWorkspace(workspaceId, async (tx) => {
    const connections = await tx.select().from(schema.connections);
    const byId = new Map(connections.map((c) => [c.id, c]));

    // --- posts ---------------------------------------------------------------------------------
    // Only published posts that actually carry the platform's id can be polled. Coarse filter here
    // (never swept, or swept over an hour ago); postIsDue() applies the real per-post cadence.
    const candidates = await tx
      .select()
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.status, 'published'),
          isNotNull(schema.posts.externalPostId),
          or(
            isNull(schema.posts.lastAnalyticsAt),
            lt(schema.posts.lastAnalyticsAt, new Date(now.getTime() - HOUR_MS)),
          ),
        ),
      );

    for (const post of candidates) {
      if (!postIsDue({ publishAt: post.publishAt, lastAnalyticsAt: post.lastAnalyticsAt, now })) {
        continue;
      }
      const conn = byId.get(post.connectionId);
      // A needs_reconnect connection can't answer; skip rather than burn a doomed call.
      if (!conn || conn.needsReconnect) continue;
      const tokens = tokensFrom(conn);
      if (!tokens) continue;

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
        // One bad account must never kill the sweep — the rest of the workspace still gets polled.
        result.flagged += (await handleSweepError(tx, workspaceId, conn, err)) ? 1 : 0;
      }
    }

    // --- accounts ------------------------------------------------------------------------------
    for (const conn of connections) {
      if (conn.needsReconnect) continue;
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
 * first tick at or after that time. A fixed number of queries whatever the workspace holds — of the
 * posts past the fresh window only the one swept longest ago matters.
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
      const sweepable = and(
        eq(schema.posts.status, 'published'),
        isNotNull(schema.posts.externalPostId),
        inArray(
          schema.posts.connectionId,
          pollable.map((c) => c.id),
        ),
      );
      const freshSince = new Date(now.getTime() - FRESH_POST_WINDOW_MS);
      const columns = {
        publishAt: schema.posts.publishAt,
        lastAnalyticsAt: schema.posts.lastAnalyticsAt,
      };
      // Fresh posts are few (two days' worth) and each has its own hourly clock.
      const fresh = await tx
        .select(columns)
        .from(schema.posts)
        .where(and(sweepable, gt(schema.posts.publishAt, freshSince)));
      // Past the window every post is daily, so the earliest due is the one swept longest ago
      // (never swept first).
      const oldest = await tx
        .select(columns)
        .from(schema.posts)
        .where(
          and(
            sweepable,
            or(isNull(schema.posts.publishAt), lte(schema.posts.publishAt, freshSince)),
          ),
        )
        .orderBy(sql`${schema.posts.lastAnalyticsAt} asc nulls first`)
        .limit(1);
      for (const p of [...fresh, ...oldest]) {
        nextDueAt = earliest(nextDueAt, nextPostDueAt({ ...p, now }));
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
