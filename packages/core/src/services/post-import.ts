import { safeFetch, type SafeFetchOptions, type SafeResponse } from '../net/safe-fetch.js';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { db, schema, withWorkspace, type Tx } from '@meegrow-social/db';
import type {
  ConnectionImportView,
  MediaKind,
  ProviderIdentifier,
} from '@meegrow-social/contracts';
import { tryGetProvider } from '../providers/registry.js';
import type { AuthTokens, SocialProvider } from '../providers/types.js';
import type { PublishedPostItem } from '../providers/published-posts.js';
import { decryptToken } from '../crypto.js';
import { getStorageDriver } from '../media/storage/index.js';
import { enqueueDeliveriesInTx } from './webhooks.js';
import { systemClock, type Clock } from './queues.js';
import {
  IMPORT_RUNS_PER_TICK,
  IMPORT_SETTLE_MS,
  IMPORT_SYNC_LOOKBACK_DAYS,
  IMPORT_BACKFILL_DAYS,
  importDue,
  parseImportState,
  planImportPage,
  queuedImportState,
  readImportWindow,
  removalCandidates,
  toImportView,
  type KnownPost,
  type StoredImportState,
} from './import-state.js';

export * from './import-state.js';

/**
 * Import past posts: bring the posts an account already has on the platform — made there, or
 * through another tool — into this app, so Content, Calendar and Analytics are not empty for a
 * client who was posting before they were connected.
 *
 * WHAT AN IMPORTED POST IS. A `posts` row with `source = 'imported'`, in a group of its own (no
 * pairing of a Facebook post with an Instagram one), `published` from the first write, carrying
 * the platform's id, link and publish time. It is never handed to the scheduler and `publishPost`
 * refuses it; the database refuses any other status for it.
 *
 * WHEN IT RUNS. The worker calls `runDueImports` every minute. A connection is due: once after it
 * is created (queued in the same insert), when an operator asks (`requestPostImport`), every
 * `IMPORT_SYNC_INTERVAL_MS` after that, and to continue a run that stopped for the rate limit.
 * There is no job per import: the state on the connection row IS the queue, so the connect request
 * never waits on it and nothing is lost if the worker restarts.
 *
 * RATE LIMIT. Small pages with a pause between them; after each page the platform's own usage
 * figures decide whether to stop (`pauseForUsage`). Stopping is not failing: the run is `paused`
 * and continues from the oldest post it read.
 */

export class ImportNotSupportedError extends Error {}

const THUMBNAIL_TIMEOUT_MS = 15_000;
const THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;

type ConnectionRow = typeof schema.connections.$inferSelect;

export interface ImportDeps {
  clock?: Clock;
  /** Injected so tests do not wait between pages. */
  sleep?: (ms: number) => Promise<void>;
  /** Fetches a thumbnail's bytes from the platform's CDN. */
  fetchImpl?: typeof fetch;
  /** The guarded transport used for WordPress thumbnails; fixtures only override this. */
  safeFetchImpl?: (url: string, options: SafeFetchOptions) => Promise<SafeResponse>;
}

/** Can this provider list an account's existing posts? Unregistered counts as no. */
export function providerImportsPosts(identifier: string): boolean {
  return Boolean(tryGetProvider(identifier as ProviderIdentifier)?.listPublishedPosts);
}

/** A connection's import state as the API reports it. */
export function connectionImportView(conn: {
  provider: string;
  importState: unknown;
  lastImportAt: Date | null;
}): ConnectionImportView {
  const view = toImportView(
    parseImportState(conn.importState),
    conn.lastImportAt,
    providerImportsPosts(conn.provider),
  );
  if (tryGetProvider(conn.provider as ProviderIdentifier)?.importsWholeHistory)
    view.windowDays = null;
  return view;
}

/** What a new connection's `import_state` starts as: a queued first backfill, where supported. */
export function initialImportState(provider: string, now: Date): StoredImportState | null {
  return providerImportsPosts(provider) ? queuedImportState(now, IMPORT_BACKFILL_DAYS) : null;
}

/**
 * Operator action "Import past posts": queue a backfill of the chosen window. Returns the state it
 * left the connection in, or null when the workspace has no such connection. A run already queued
 * or in progress is left as it is rather than restarted — asking twice imports once.
 */
export async function requestPostImport(
  workspaceId: string,
  connectionId: string,
  input: { windowDays: number },
  clock: Clock = systemClock,
): Promise<ConnectionImportView | null> {
  const now = clock.now();
  return withWorkspace(workspaceId, async (tx) => {
    const [conn] = await tx
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId))
      .limit(1)
      .for('update');
    if (!conn) return null;
    if (!providerImportsPosts(conn.provider)) {
      throw new ImportNotSupportedError(`past posts cannot be imported from "${conn.provider}"`);
    }
    const current = parseImportState(conn.importState);
    const due = importDue(
      {
        importState: current,
        lastImportAt: conn.lastImportAt,
        needsReconnect: false,
        hasToken: true,
        supported: true,
      },
      now,
    );
    // `queued`, a live `running`, or a `paused` run that is still waiting.
    const busy =
      current !== null &&
      (current.status === 'queued' ||
        (current.status === 'running' && due === null) ||
        current.status === 'paused');
    if (busy) return connectionImportView(conn);

    const importState = queuedImportState(now, input.windowDays);
    await tx
      .update(schema.connections)
      .set({ importState })
      .where(eq(schema.connections.id, connectionId));
    return connectionImportView({ ...conn, importState });
  });
}

export interface ImportRunResult {
  connectionId: string;
  status: StoredImportState['status'];
  imported: number;
  matched: number;
  removed: number;
  capped: boolean;
}

export interface ImportTickResult {
  /** Runs started this tick. */
  runs: ImportRunResult[];
}

/**
 * One worker tick: start at most `IMPORT_RUNS_PER_TICK` due imports, one after another, across
 * every workspace. Enumerates workspaces on the admin handle and works under `withWorkspace`, like
 * the analytics sweep. One connection's failure never stops the next.
 */
export async function runDueImports(deps: ImportDeps = {}): Promise<ImportTickResult> {
  const clock = deps.clock ?? systemClock;
  const workspaces = await db().select({ id: schema.workspaces.id }).from(schema.workspaces);
  const result: ImportTickResult = { runs: [] };
  for (const ws of workspaces) {
    if (result.runs.length >= IMPORT_RUNS_PER_TICK) break;
    const connections = await withWorkspace(ws.id, (tx) =>
      tx
        .select({
          id: schema.connections.id,
          provider: schema.connections.provider,
          importState: schema.connections.importState,
          lastImportAt: schema.connections.lastImportAt,
          needsReconnect: schema.connections.needsReconnect,
          accessToken: schema.connections.accessToken,
        })
        .from(schema.connections),
    );
    for (const conn of connections) {
      if (result.runs.length >= IMPORT_RUNS_PER_TICK) break;
      const due = importDue(
        {
          importState: parseImportState(conn.importState),
          lastImportAt: conn.lastImportAt,
          needsReconnect: conn.needsReconnect,
          hasToken: conn.accessToken !== null,
          supported: providerImportsPosts(conn.provider),
        },
        clock.now(),
      );
      if (!due) continue;
      const run = await runConnectionImport(ws.id, conn.id, deps);
      if (run) result.runs.push(run);
    }
  }
  return result;
}

interface Claim {
  conn: ConnectionRow;
  tokens: AuthTokens;
  provider: SocialProvider;
  state: StoredImportState;
}

/**
 * Take the run under the connection's row lock, so two workers never import one account at once:
 * the second finds it `running` and not stale, and leaves.
 */
async function claimImport(
  workspaceId: string,
  connectionId: string,
  now: Date,
): Promise<Claim | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const [conn] = await tx
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId))
      .limit(1)
      .for('update');
    if (!conn || !conn.accessToken) return null;
    const provider = tryGetProvider(conn.provider as ProviderIdentifier);
    if (!provider?.listPublishedPosts) return null;
    const due = importDue(
      {
        importState: parseImportState(conn.importState),
        lastImportAt: conn.lastImportAt,
        needsReconnect: conn.needsReconnect,
        hasToken: true,
        supported: true,
      },
      now,
    );
    if (!due) return null;

    const base =
      due.action === 'run'
        ? { ...due.state, resumed: due.state.resumed || due.resumed }
        : due.action === 'first'
          ? queuedImportState(now, IMPORT_BACKFILL_DAYS)
          : queuedImportState(now, IMPORT_SYNC_LOOKBACK_DAYS, 'sync');
    const state: StoredImportState = {
      ...base,
      status: 'running',
      startedAt: now.toISOString(),
      finishedAt: null,
      resumeAt: null,
      message: null,
    };
    await tx
      .update(schema.connections)
      .set({ importState: state })
      .where(eq(schema.connections.id, connectionId));
    return {
      conn,
      provider,
      state,
      tokens: {
        accessToken: decryptToken(conn.accessToken),
        refreshToken: conn.refreshToken ? decryptToken(conn.refreshToken) : undefined,
        externalId: conn.externalId,
        displayName: conn.displayName,
      },
    };
  });
}

/**
 * Run one connection's due import to its end, its pause, or its failure. Returns null when there
 * was nothing to run (not due, another worker has it, no token, provider cannot list).
 *
 * Never throws for a platform failure: the outcome is written to the connection, where the
 * operator sees it. No transaction is held across a platform call — each page is read, then
 * written in its own transaction, so a run that dies keeps the pages it finished.
 */
export async function runConnectionImport(
  workspaceId: string,
  connectionId: string,
  deps: ImportDeps = {},
): Promise<ImportRunResult | null> {
  const clock = deps.clock ?? systemClock;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const claim = await claimImport(workspaceId, connectionId, clock.now());
  if (!claim) return null;
  const { conn, provider, tokens } = claim;
  let state = claim.state;

  const since = new Date(state.since);
  // Nothing newer than this is read: see IMPORT_SETTLE_MS.
  const settled = new Date(clock.now().getTime() - IMPORT_SETTLE_MS);
  const read = await readImportWindow(
    state,
    !provider.importsWholeHistory && state.until ? new Date(state.until) : settled,
    {
      list: (query) => provider.listPublishedPosts!(tokens, query),
      apply: (items) => applyImportPage(workspaceId, conn, items, deps),
      progress: (importState) =>
        withWorkspace(workspaceId, async (tx) => {
          await tx
            .update(schema.connections)
            .set({ importState })
            .where(eq(schema.connections.id, conn.id));
        }),
      sleep,
      now: () => clock.now(),
      wholeHistory: provider.importsWholeHistory,
    },
  );
  state = read.state;
  const authFailed = read.authFailed;

  if (read.complete) {
    // A list that was read in one piece, to its end, is the only one a missing post can be judged
    // against — so not after the post limit, and not for a run that continued from a pause.
    if (!state.capped && !state.resumed) {
      try {
        const removed = await markRemovedPosts(
          workspaceId,
          conn,
          provider,
          tokens,
          read.recognised,
          { since, until: settled },
          clock.now(),
        );
        state = { ...state, removed: state.removed + removed };
      } catch {
        // The posts are imported; checking for removed ones is tried again on the next run.
      }
    }
    state = { ...state, status: 'done', until: null, resumeAt: null };
  }

  const finishedAt = clock.now();
  if (state.status !== 'paused') state = { ...state, finishedAt: finishedAt.toISOString() };
  const final = state;
  await withWorkspace(workspaceId, async (tx) => {
    await tx
      .update(schema.connections)
      .set({
        importState: final,
        ...(final.status === 'done' ? { lastImportAt: finishedAt } : {}),
        ...(authFailed ? { needsReconnect: true } : {}),
      })
      .where(eq(schema.connections.id, conn.id));
    if (authFailed) {
      await enqueueDeliveriesInTx(tx, workspaceId, 'connection.needs_reconnect', {
        connectionId: conn.id,
        provider: conn.provider,
        externalId: conn.externalId,
      });
    }
    // Quiet periodic checks that changed nothing are not worth a log line every six hours.
    const quiet =
      final.kind === 'sync' && final.status === 'done' && final.imported + final.removed === 0;
    if (!quiet) {
      await tx.insert(schema.eventLogs).values({
        workspaceId,
        kind: 'connection',
        status: `import_${final.status}`,
        platform: conn.provider,
        account: conn.displayName,
        message:
          `Past posts: ${final.imported} imported, ${final.matched} already here, ` +
          `${final.removed} removed on platform` +
          (final.message ? ` — ${final.message}` : ''),
      });
    }
  });

  return {
    connectionId: conn.id,
    status: final.status,
    imported: final.imported,
    matched: final.matched,
    removed: final.removed,
    capped: final.capped,
  };
}

interface AppliedPage {
  /** Posts inserted. */
  imported: number;
  /** Posts this app published that the page listed. */
  matched: number;
  /** Every stored post the page accounts for: the ones recognised and the ones just inserted. */
  recognised: string[];
}

interface StoredThumbnail {
  url: string;
  key: string;
  bytes: number;
}

/** A media ref as an imported post stores it. `thumbnailUrl` is the still of a video we do not hold. */
export interface ImportedMediaRef {
  mediaId: string;
  kind: MediaKind;
  url?: string;
  thumbnailUrl?: string;
}

/**
 * Write one page of listed posts: recognise the ones already stored, insert the rest.
 *
 * Three steps so that no transaction is open during a network call: read the candidates, copy the
 * thumbnails of the new posts, write. A post that turns out to exist by the time of the write (a
 * concurrent run) hits the unique index and is skipped, with its group taken back out.
 */
export async function applyImportPage(
  workspaceId: string,
  conn: Pick<ConnectionRow, 'id' | 'provider'>,
  items: readonly PublishedPostItem[],
  deps: ImportDeps = {},
): Promise<AppliedPage> {
  if (items.length === 0) return { imported: 0, matched: 0, recognised: [] };
  const ids = [...new Set(items.flatMap((i) => [i.externalPostId, ...i.alternateIds]))];
  const urls = [
    ...new Set(items.flatMap((i) => [i.permalink, ...i.knownUrls]).filter((u) => u !== null)),
  ];

  const known: KnownPost[] = await withWorkspace(workspaceId, (tx) =>
    tx
      .select({
        id: schema.posts.id,
        source: schema.posts.source,
        status: schema.posts.status,
        externalPostId: schema.posts.externalPostId,
        releaseUrl: schema.posts.releaseUrl,
        publishAt: schema.posts.publishAt,
        caption: schema.posts.caption,
        options: schema.posts.options,
        platformRemovedAt: schema.posts.platformRemovedAt,
      })
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.connectionId, conn.id),
          or(
            inArray(schema.posts.externalPostId, ids),
            urls.length > 0 ? inArray(schema.posts.releaseUrl, urls) : undefined,
          ),
        ),
      ),
  );
  const plan = planImportPage(items, known);

  const thumbnails = new Map<string, StoredThumbnail>();
  for (const item of plan.inserts) {
    const stored =
      conn.provider === 'wordpress'
        ? await copyWordPressThumbnail(workspaceId, item, deps.safeFetchImpl)
        : await copyThumbnail(workspaceId, item, deps.fetchImpl);
    if (stored) thumbnails.set(item.externalPostId, stored);
  }

  const inserted: string[] = [];
  await withWorkspace(workspaceId, async (tx) => {
    for (const { postId, patch } of plan.patches) {
      await tx.update(schema.posts).set(patch).where(eq(schema.posts.id, postId));
    }
    for (const item of plan.inserts) {
      const id = await insertImportedPost(
        tx,
        workspaceId,
        conn,
        item,
        thumbnails.get(item.externalPostId),
      );
      if (id) inserted.push(id);
    }
  });
  return {
    imported: inserted.length,
    matched: plan.ownMatched,
    recognised: [...plan.recognised, ...inserted],
  };
}

async function insertImportedPost(
  tx: Tx,
  workspaceId: string,
  conn: Pick<ConnectionRow, 'id' | 'provider'>,
  item: PublishedPostItem,
  thumbnail: StoredThumbnail | undefined,
): Promise<string | null> {
  let media: ImportedMediaRef[] = [];
  let mediaId: string | null = null;
  if (thumbnail && item.mediaKind) {
    // A media row so the stored object is accounted for and the ref has a real id. Marked, so the
    // media library does not offer a 720px copy of someone's old post as an upload.
    const [row] = await tx
      .insert(schema.media)
      .values({
        workspaceId,
        kind: 'image',
        url: thumbnail.url,
        s3Key: thumbnail.key,
        bytes: thumbnail.bytes,
        meta: { imported: true },
      })
      .returning({ id: schema.media.id });
    mediaId = row?.id ?? null;
    if (mediaId) {
      media = [
        item.mediaKind === 'video'
          ? { mediaId, kind: 'video', thumbnailUrl: thumbnail.url }
          : { mediaId, kind: 'image', url: thumbnail.url },
      ];
    }
  }

  const [group] = await tx
    .insert(schema.postGroups)
    .values({ workspaceId, caption: item.caption, media })
    .returning({ id: schema.postGroups.id });
  if (!group) throw new Error('failed to create the group of an imported post');

  const inserted = await tx
    .insert(schema.posts)
    .values({
      workspaceId,
      groupId: group.id,
      connectionId: conn.id,
      provider: conn.provider,
      // Already live on the platform. Never `scheduled`, so no publish job can ever act on it.
      status: 'published',
      source: 'imported',
      caption: item.caption,
      options: item.options ?? null,
      media,
      publishAt: item.publishedAt,
      releaseUrl: item.permalink,
      externalPostId: item.externalPostId,
    })
    .onConflictDoNothing({
      target: [schema.posts.connectionId, schema.posts.externalPostId],
      where: eq(schema.posts.source, 'imported'),
    })
    .returning({ id: schema.posts.id });
  if (inserted[0]) return inserted[0].id;

  // Someone else stored it between the read and this write. Take the empty group back out.
  await tx.delete(schema.postGroups).where(eq(schema.postGroups.id, group.id));
  if (mediaId) await tx.delete(schema.media).where(eq(schema.media.id, mediaId));
  return null;
}

const IMAGE_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Copy a post's still into our own storage. The platform's url is short-lived (RESEARCH meta.md
 * §7.2), so it is fetched once, here, and never stored. Never throws: a post without a picture is
 * still worth importing, so every failure — no url, a non-image, too large, storage down — is
 * "no thumbnail".
 */
export async function copyThumbnail(
  workspaceId: string,
  item: Pick<PublishedPostItem, 'thumbnailUrl' | 'mediaKind'>,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredThumbnail | null> {
  if (!item.thumbnailUrl || !item.mediaKind) return null;
  try {
    if (new URL(item.thumbnailUrl).protocol !== 'https:') return null;
    const res = await fetchImpl(item.thumbnailUrl, {
      signal: AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const extension = IMAGE_EXTENSION[contentType];
    if (!extension) return null;
    if (Number(res.headers.get('content-length') ?? 0) > THUMBNAIL_MAX_BYTES) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > THUMBNAIL_MAX_BYTES) return null;
    const stored = await getStorageDriver().put({
      workspaceId,
      filename: `imported${extension}`,
      contentType,
      data,
    });
    return { url: stored.url, key: stored.key, bytes: data.byteLength };
  } catch {
    return null;
  }
}

/**
 * After a complete read of a window: ask the platform about each stored post of that window the
 * list did not contain, and mark the ones it confirms are gone. Two independent signals are
 * required — absent from the list AND "does not exist" on its own node — because either alone is
 * wrong sometimes: the list is ranked and filtered, and a single read can fail for other reasons.
 *
 * Applies to every published post of the account, whoever published it. Returns how many were marked.
 */
async function markRemovedPosts(
  workspaceId: string,
  conn: Pick<ConnectionRow, 'id'>,
  provider: SocialProvider,
  tokens: AuthTokens,
  recognised: ReadonlySet<string>,
  window: { since: Date; until: Date },
  now: Date,
): Promise<number> {
  if (!provider.publishedPostPresence) return 0;
  const known = await withWorkspace(workspaceId, (tx) =>
    tx
      .select({
        id: schema.posts.id,
        status: schema.posts.status,
        externalPostId: schema.posts.externalPostId,
        publishAt: schema.posts.publishAt,
        platformRemovedAt: schema.posts.platformRemovedAt,
        createdAt: schema.posts.createdAt,
      })
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.connectionId, conn.id),
          eq(schema.posts.status, 'published'),
          isNotNull(schema.posts.externalPostId),
          isNull(schema.posts.platformRemovedAt),
          // Coarse: a post created before the window can still have been published inside it, and
          // `removalCandidates` applies the real bounds.
          provider.importsWholeHistory
            ? undefined
            : or(
                and(
                  gt(schema.posts.publishAt, window.since),
                  lt(schema.posts.publishAt, window.until),
                ),
                and(isNull(schema.posts.publishAt), gt(schema.posts.createdAt, window.since)),
              ),
        ),
      )
      .orderBy(desc(schema.posts.publishAt)),
  );
  const gone: string[] = [];
  for (const post of removalCandidates(
    known,
    recognised,
    window,
    undefined,
    provider.importsWholeHistory,
  )) {
    if ((await provider.publishedPostPresence(tokens, post.externalPostId!)) === 'gone') {
      gone.push(post.id);
    }
  }
  if (gone.length === 0) return 0;
  await withWorkspace(workspaceId, (tx) =>
    tx
      .update(schema.posts)
      .set({ platformRemovedAt: now })
      .where(and(inArray(schema.posts.id, gone), isNull(schema.posts.platformRemovedAt))),
  );
  return gone.length;
}

/** Every WordPress featured-image URL is untrusted and uses the site's SSRF guard. */
export async function copyWordPressThumbnail(
  workspaceId: string,
  item: Pick<PublishedPostItem, 'thumbnailUrl' | 'mediaKind'>,
  fetchImpl: (url: string, options: SafeFetchOptions) => Promise<SafeResponse> = safeFetch,
): Promise<StoredThumbnail | null> {
  return copyThumbnail(workspaceId, item, async (url) => {
    const response = await fetchImpl(String(url), {
      timeoutMs: THUMBNAIL_TIMEOUT_MS,
      maxResponseBytes: THUMBNAIL_MAX_BYTES,
      maxRedirects: 3,
    });
    return new Response(new Uint8Array(response.body), {
      status: response.status,
      headers: response.headers,
    });
  });
}
