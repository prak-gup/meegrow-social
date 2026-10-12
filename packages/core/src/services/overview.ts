import { DateTime, IANAZone } from 'luxon';
import { AnalyticsQueryError } from './analytics-report.js';
import { and, desc, eq, isNotNull, like } from 'drizzle-orm';
import { db, schema, withWorkspace } from '@meegrow-social/db';
import type { OverviewView, ClientHealth, ProviderIdentifier } from '@meegrow-social/contracts';
import { computeHealth } from './connections.js';
import { EXPIRING_WINDOW_MS } from './connections.js';
import { systemClock, type Clock } from './queues.js';
import { providerVisible } from '../providers/registry.js';

/**
 * Cross-client control-tower rollup (the redesign's home screen). Aggregates every workspace the
 * user belongs to into one payload: per-client health, this-week publishing, the soonest scheduled
 * post, followers, and a global attention list. Session-authed (needs the user's memberships).
 *
 * Each workspace is read under `withWorkspace` so RLS isolates it — the rollup never bypasses
 * tenancy; it fans out over the memberships and stitches the per-tenant results together.
 *
 * Connections and posts on a provider that is not `providerVisible` (the test-only `fake*` family,
 * in production) are left out of every number here — the dashboard already hides them everywhere
 * else, so counting them made the home screen disagree with the screens it links to.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const AUTOMATION_LIVE_MS = 10 * 60 * 1000; // an API key used in the last 10 min => "bot live"

export async function overviewForUser(
  userId: string,
  clock: Clock = systemClock,
  timezone = 'UTC',
): Promise<OverviewView> {
  const now = clock.now();
  if (!IANAZone.isValidZone(timezone)) throw new AnalyticsQueryError('Invalid timezone');
  const weekStart = DateTime.fromJSDate(now, { zone: timezone }).startOf('week').toJSDate();
  const weekAgo = new Date(now.getTime() - WEEK_MS);
  const expiringThreshold = new Date(now.getTime() + EXPIRING_WINDOW_MS);

  // Memberships are identity/routing tables — read on the admin handle, pre-tenant (like auth does).
  const rows = await db()
    .select({
      workspaceId: schema.memberships.workspaceId,
      role: schema.memberships.role,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
    })
    .from(schema.memberships)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
    .where(eq(schema.memberships.userId, userId));

  const clients: OverviewView['clients'] = [];
  const upcoming: OverviewView['upcoming'] = [];
  const upcomingGroups: OverviewView['upcomingGroups'] = [];
  let failedPublishes = 0;
  let needsReconnect = 0;
  let tokensExpiring = 0;
  let emptyQueues = 0;
  let publishedThisWeek = 0;

  for (const ws of rows) {
    const per = await withWorkspace(ws.workspaceId, async (tx) => {
      const conns = (await tx.select().from(schema.connections)).filter((c) =>
        providerVisible(c.provider),
      );
      const posts = (await tx.select().from(schema.posts)).filter((p) =>
        providerVisible(p.provider),
      );

      const groups = await tx.select().from(schema.postGroups);
      const captions = new Map(groups.map((g) => [g.id, g.caption]));

      // connection health
      let anyBad = false;
      let anyExpiring = false;
      let followers: number | null = null;
      for (const c of conns) {
        const h = computeHealth(c.tokenModel as never, c.needsReconnect, c.expiresAt);
        if (h === 'needs_reconnect') anyBad = true;
        if (h === 'expiring') anyExpiring = true;
        if (c.needsReconnect) needsReconnect += 1;
        if (!c.needsReconnect && c.expiresAt && c.expiresAt < expiringThreshold)
          tokensExpiring += 1;
      }

      // latest followers across this workspace's connections (sum of most-recent per connection)
      if (conns.length > 0) {
        const followerRows = await tx
          .select()
          .from(schema.metrics)
          .where(
            and(eq(schema.metrics.metric, 'followers'), isNotNull(schema.metrics.connectionId)),
          )
          .orderBy(desc(schema.metrics.capturedAt))
          .limit(1000); // bound the scan; latest-per-connection only needs recent rows
        // Only connections counted above contribute: `metrics` has no FK, so it also holds rows for
        // hidden and since-removed connections.
        const counted = new Set(conns.map((c) => c.id));
        const latestByConn = new Map<string, number>();
        for (const m of followerRows) {
          if (m.connectionId && counted.has(m.connectionId) && !latestByConn.has(m.connectionId)) {
            latestByConn.set(m.connectionId, Number(m.value));
          }
        }
        if (latestByConn.size > 0) {
          followers = [...latestByConn.values()].reduce((a, b) => a + b, 0);
        }
      }

      // posts this week + failures + next scheduled
      const publishedGroups = new Set<string>();
      const scheduledGroups = new Map<string, OverviewView['upcomingGroups'][number]>();
      let failed = 0;
      let nextPublishAt: Date | null = null;
      let hasUpcoming = false;
      for (const p of posts) {
        if (
          p.status === 'published' &&
          !p.platformRemovedAt &&
          p.publishAt &&
          p.publishAt >= weekStart &&
          p.publishAt <= now
        )
          publishedGroups.add(p.groupId);
        if (p.status === 'failed' && p.createdAt >= weekAgo) failed += 1;
        if (p.status === 'scheduled' && !p.platformRemovedAt && p.publishAt && p.publishAt > now) {
          hasUpcoming = true;
          if (!nextPublishAt || p.publishAt < nextPublishAt) nextPublishAt = p.publishAt;
          const options = p.options as { kind?: string; title?: string } | null;
          const caption =
            options?.kind === 'wordpress'
              ? (options.title ?? p.caption)
              : (captions.get(p.groupId) ?? p.caption);
          const group = scheduledGroups.get(p.groupId) ?? {
            groupId: p.groupId,
            workspaceId: ws.workspaceId,
            workspaceName: ws.name,
            caption,
            publishAt: p.publishAt,
            laterCount: 0,
            accounts: [],
          };
          if (p.publishAt < group.publishAt) {
            group.publishAt = p.publishAt;
            group.caption = caption;
          }
          group.accounts.push({
            connectionId: p.connectionId,
            provider: p.provider as ProviderIdentifier,
            name: conns.find((c) => c.id === p.connectionId)?.displayName ?? p.provider,
          });
          scheduledGroups.set(p.groupId, group);
          upcoming.push({
            workspaceId: ws.workspaceId,
            workspaceName: ws.name,
            provider: p.provider as ProviderIdentifier,
            caption: p.caption,
            publishAt: p.publishAt,
          });
        }
      }

      for (const group of scheduledGroups.values()) {
        group.laterCount = posts.filter(
          (p) =>
            p.groupId === group.groupId &&
            p.status === 'scheduled' &&
            !p.platformRemovedAt &&
            p.publishAt &&
            p.publishAt > group.publishAt,
        ).length;
        upcomingGroups.push(group);
      }

      // automation-live: an API key used very recently
      const keys = await db()
        .select({ lastUsedAt: schema.apiKeys.lastUsedAt })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.workspaceId, ws.workspaceId));
      const automationLive = keys.some(
        (k) => k.lastUsedAt && now.getTime() - k.lastUsedAt.getTime() < AUTOMATION_LIVE_MS,
      );

      return {
        conns,
        anyBad,
        anyExpiring,
        followers,
        published: publishedGroups.size,
        failed,
        nextPublishAt,
        hasUpcoming,
        automationLive,
      };
    });

    failedPublishes += per.failed;
    publishedThisWeek += per.published;
    if (!per.hasUpcoming) emptyQueues += 1;

    const health: ClientHealth = per.anyBad
      ? 'bad'
      : per.anyExpiring || per.failed > 0 || !per.hasUpcoming
        ? 'warn'
        : 'ok';

    clients.push({
      workspaceId: ws.workspaceId,
      name: ws.name,
      slug: ws.slug,
      health,
      connectionCount: per.conns.length,
      publishedThisWeek: per.published,
      failedThisWeek: per.failed,
      nextPublishAt: per.nextPublishAt,
      followers: per.followers,
      automationLive: per.automationLive,
    });
  }

  clients.sort((a, b) => a.name.localeCompare(b.name));
  upcoming.sort((a, b) => a.publishAt.getTime() - b.publishAt.getTime());

  return {
    generatedAt: now,
    attention: { failedPublishes, needsReconnect, tokensExpiring, emptyQueues },
    weekTotals: { publishedThisWeek },
    clients,
    upcoming: upcoming.slice(0, 12),
    upcomingGroups: upcomingGroups
      .sort(
        (a, b) =>
          a.publishAt.getTime() - b.publishAt.getTime() || a.groupId.localeCompare(b.groupId),
      )
      .slice(0, 12),
  };
}

/**
 * The workspace an API key is bound to (D1 `get_workspace` / `list_workspaces`). A key has no user,
 * so `overviewForUser` cannot answer "where am I" for an agent. Identity fields only. Runs on the
 * admin handle — `workspaces` is a non-tenant table, so the id predicate is the only scoping:
 * callers must pass the authenticated context's workspace id, never one supplied by a client.
 */
export async function getWorkspace(
  workspaceId: string,
): Promise<{ id: string; name: string; slug: string } | null> {
  const [ws] = await db()
    .select({
      id: schema.workspaces.id,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return ws ?? null;
}

/**
 * Create a new client workspace and make the caller its owner (the "Add client" action). Runs on the
 * admin handle — workspaces/memberships are non-tenant identity tables. Slug is derived and made
 * unique with a short suffix so two clients can share a display name.
 */
export async function createClientWorkspace(
  userId: string,
  name: string,
): Promise<{ workspaceId: string; name: string; slug: string }> {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'client';

  // Compute the first free suffix from ALL existing base-prefixed slugs (open-ended, not a fixed
  // probe list), then INSERT with retry on the unique constraint so a concurrent create can't 500 —
  // the DB, not the pre-check, is the source of truth for uniqueness.
  const rows = await db()
    .select({ slug: schema.workspaces.slug })
    .from(schema.workspaces)
    .where(like(schema.workspaces.slug, `${base}%`));
  const taken = new Set(rows.map((r) => r.slug));

  const nextSlug = (): string => {
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const s = `${base}-${n}`;
      if (!taken.has(s)) return s;
    }
  };

  for (let attempt = 0; attempt < 6; attempt++) {
    const slug = nextSlug();
    try {
      const [ws] = await db()
        .insert(schema.workspaces)
        .values({ name: name.trim(), slug })
        .returning();
      if (!ws) throw new Error('failed to create workspace');
      await db().insert(schema.memberships).values({ userId, workspaceId: ws.id, role: 'owner' });
      return { workspaceId: ws.id, name: ws.name, slug: ws.slug };
    } catch (err) {
      // 23505 = unique_violation: someone took this slug between our read and insert. Mark it taken
      // and try the next suffix.
      if (typeof err === 'object' && err && (err as { code?: string }).code === '23505') {
        taken.add(slug);
        continue;
      }
      throw err;
    }
  }
  throw new Error('could not allocate a unique slug for the workspace');
}
