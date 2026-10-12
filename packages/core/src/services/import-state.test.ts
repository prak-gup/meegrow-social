import { describe, expect, it, vi } from 'vitest';
import type { PublishedPostItem, PublishedPostPage } from '../providers/published-posts.js';
import {
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderRateLimitError,
  ProviderTransientError,
} from '../errors.js';
import {
  IMPORT_BACKFILL_DAYS,
  IMPORT_MAX_PAGES_PER_RUN,
  IMPORT_MAX_POSTS_PER_RUN,
  IMPORT_PAGE_DELAY_MS,
  IMPORT_PAGE_SIZE,
  IMPORT_PAUSE_MS,
  IMPORT_STALE_RUN_MS,
  IMPORT_SYNC_INTERVAL_MS,
  IMPORT_USAGE_PAUSE_PERCENT,
  importDue,
  parseImportState,
  pauseForUsage,
  planImportPage,
  queuedImportState,
  readImportWindow,
  removalCandidates,
  toImportView,
  type KnownPost,
  type StoredImportState,
} from './import-state.js';

/**
 * The rules of "import past posts" as pure functions: when a connection is due, how a listed post
 * is matched against what is stored, when the read stops for the rate limit, and which posts may
 * be asked about as removed. The writes are covered by post-import.integration.test.ts.
 */

const NOW = new Date('2026-10-11T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

const item = (id: string, over: Partial<PublishedPostItem> = {}): PublishedPostItem => ({
  externalPostId: id,
  alternateIds: [],
  knownUrls: [],
  caption: `caption of ${id}`,
  publishedAt: ago(3 * DAY),
  permalink: `https://platform.test/p/${id}`,
  mediaKind: 'image',
  mediaCount: 1,
  thumbnailUrl: `https://cdn.test/${id}.jpg`,
  ...over,
});

const known = (id: string, over: Partial<KnownPost> = {}): KnownPost => ({
  id,
  source: 'app',
  status: 'published',
  externalPostId: null,
  releaseUrl: null,
  publishAt: null,
  caption: 'what we sent',
  platformRemovedAt: null,
  ...over,
});

const connection = (
  importState: StoredImportState | null,
  over: Partial<Parameters<typeof importDue>[0]> = {},
) => ({
  importState,
  lastImportAt: null,
  needsReconnect: false,
  hasToken: true,
  supported: true,
  ...over,
});

describe('queuedImportState / parseImportState', () => {
  it('queues a backfill reaching back the asked number of days', () => {
    const state = queuedImportState(NOW, 90);
    expect(state).toMatchObject({ status: 'queued', kind: 'backfill', windowDays: 90, seen: 0 });
    expect(new Date(state.since)).toEqual(ago(90 * DAY));
  });

  it('round-trips through jsonb', () => {
    const state = queuedImportState(NOW, 30, 'sync');
    expect(parseImportState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('reads anything that is not a state as "never imported", without throwing', () => {
    for (const junk of [null, undefined, 'queued', 7, {}, { status: 'nope', since: 'x' }, []]) {
      expect(parseImportState(junk)).toBeNull();
    }
  });

  it('reports "never imported" as a view with no status and zero counts', () => {
    expect(toImportView(null, null, true)).toMatchObject({
      supported: true,
      status: null,
      imported: 0,
      capped: false,
      lastSyncedAt: null,
    });
    expect(toImportView(null, null, false).supported).toBe(false);
  });

  it('shows when a paused run resumes, and nothing of the kind once it is done', () => {
    const paused = { ...queuedImportState(NOW, 90), status: 'paused' as const };
    const resumeAt = new Date(NOW.getTime() + HOUR).toISOString();
    expect(toImportView({ ...paused, resumeAt }, null, true).resumeAt).toEqual(new Date(resumeAt));
    expect(toImportView({ ...paused, status: 'done', resumeAt }, NOW, true).resumeAt).toBeNull();
  });
});

describe('importDue', () => {
  it('gives a connection with no state the automatic first backfill', () => {
    expect(importDue(connection(null), NOW)).toEqual({ action: 'first' });
  });

  it('is never due for a provider that cannot list posts, a dead token, or no token', () => {
    const queued = queuedImportState(NOW, 90);
    expect(importDue(connection(null, { supported: false }), NOW)).toBeNull();
    expect(importDue(connection(queued, { supported: false }), NOW)).toBeNull();
    expect(importDue(connection(queued, { needsReconnect: true }), NOW)).toBeNull();
    expect(importDue(connection(queued, { hasToken: false }), NOW)).toBeNull();
  });

  it('runs a queued import', () => {
    const queued = queuedImportState(NOW, 365);
    expect(importDue(connection(queued), NOW)).toEqual({
      action: 'run',
      state: queued,
      resumed: false,
    });
  });

  it('leaves a paused run alone until its resume time, then continues it', () => {
    const paused: StoredImportState = {
      ...queuedImportState(ago(HOUR), 90),
      status: 'paused',
      resumeAt: new Date(NOW.getTime() + 10 * MINUTE).toISOString(),
    };
    expect(importDue(connection(paused), NOW)).toBeNull();
    expect(importDue(connection(paused), new Date(NOW.getTime() + 10 * MINUTE))).toEqual({
      action: 'run',
      state: paused,
      resumed: true,
    });
  });

  it('does not start a second run while one is running, but takes over one that died', () => {
    const running = (startedAgo: number): StoredImportState => ({
      ...queuedImportState(ago(startedAgo), 90),
      status: 'running',
      startedAt: ago(startedAgo).toISOString(),
    });
    expect(importDue(connection(running(5 * MINUTE)), NOW)).toBeNull();
    expect(importDue(connection(running(IMPORT_STALE_RUN_MS - 1)), NOW)).toBeNull();
    expect(importDue(connection(running(IMPORT_STALE_RUN_MS)), NOW)).toMatchObject({
      action: 'run',
      resumed: true,
    });
  });

  it('checks a finished account again every sync interval, and not sooner', () => {
    const done = (finishedAgo: number): StoredImportState => ({
      ...queuedImportState(ago(DAY), 90),
      status: 'done',
      finishedAt: ago(finishedAgo).toISOString(),
    });
    const at = (lastAgo: number) =>
      importDue(connection(done(lastAgo), { lastImportAt: ago(lastAgo) }), NOW);
    expect(at(IMPORT_SYNC_INTERVAL_MS - MINUTE)).toBeNull();
    expect(at(IMPORT_SYNC_INTERVAL_MS)).toEqual({ action: 'sync' });
  });

  it('asks again for a failed run as it was, after the interval — never as a shorter one', () => {
    const failed: StoredImportState = {
      ...queuedImportState(ago(7 * HOUR), 365),
      status: 'failed',
      finishedAt: ago(7 * HOUR).toISOString(),
      message: 'Import failed: boom',
    };
    expect(importDue(connection({ ...failed, finishedAt: ago(HOUR).toISOString() }), NOW)).toBe(
      null,
    );
    const due = importDue(connection(failed), NOW);
    expect(due).toMatchObject({ action: 'run', resumed: false });
    expect(due?.action === 'run' && due.state).toMatchObject({
      status: 'queued',
      kind: 'backfill',
      windowDays: 365,
      message: null,
    });
  });
});

describe('pauseForUsage', () => {
  it('carries on when the platform reports nothing, or usage under the threshold', () => {
    expect(pauseForUsage(null, NOW)).toBeNull();
    expect(
      pauseForUsage({ percent: IMPORT_USAGE_PAUSE_PERCENT - 1, regainAccessMinutes: null }, NOW),
    ).toBeNull();
  });

  it('stops at the threshold — half the allowance, so publishing always has room', () => {
    expect(IMPORT_USAGE_PAUSE_PERCENT).toBeLessThanOrEqual(50);
    expect(
      pauseForUsage({ percent: IMPORT_USAGE_PAUSE_PERCENT, regainAccessMinutes: null }, NOW),
    ).toEqual(new Date(NOW.getTime() + IMPORT_PAUSE_MS));
  });

  it('stops whenever the platform says it is throttling, and waits as long as it says', () => {
    expect(pauseForUsage({ percent: 10, regainAccessMinutes: 5 }, NOW)).toEqual(
      new Date(NOW.getTime() + IMPORT_PAUSE_MS),
    );
    expect(pauseForUsage({ percent: 100, regainAccessMinutes: 240 }, NOW)).toEqual(
      new Date(NOW.getTime() + 240 * MINUTE),
    );
  });
});

describe('planImportPage — recognition and idempotency', () => {
  it('inserts a post nobody has stored', () => {
    const plan = planImportPage([item('a'), item('b')], []);
    expect(plan.inserts.map((i) => i.externalPostId)).toEqual(['a', 'b']);
    expect(plan).toMatchObject({ patches: [], recognised: [], ownMatched: 0 });
  });

  it('importing the same page again inserts nothing', () => {
    const first = [item('a'), item('b')];
    const stored = first.map((i) =>
      known(`row-${i.externalPostId}`, {
        source: 'imported',
        externalPostId: i.externalPostId,
        releaseUrl: i.permalink,
        publishAt: i.publishedAt,
        caption: i.caption,
      }),
    );
    const again = planImportPage(first, stored);
    expect(again.inserts).toEqual([]);
    expect(again.patches).toEqual([]);
    expect(again.recognised).toEqual(['row-a', 'row-b']);
    expect(again.ownMatched).toBe(0);
  });

  it('lists the same post twice on a page as one post', () => {
    expect(planImportPage([item('a'), item('a')], []).inserts).toHaveLength(1);
  });

  it('recognises a post this app published by its platform id and never duplicates it', () => {
    const own = known('ours', { externalPostId: 'a', publishAt: ago(4 * DAY) });
    const plan = planImportPage([item('a')], [own]);
    expect(plan.inserts).toEqual([]);
    expect(plan.recognised).toEqual(['ours']);
    expect(plan.ownMatched).toBe(1);
    // It has a time and an id already: nothing to change, and the caption is what we sent.
    expect(plan.patches).toEqual([]);
  });

  it('gives a post of ours with no stored publish time the platform timestamp', () => {
    const own = known('ours', { externalPostId: 'a', publishAt: null });
    const listed = item('a', { publishedAt: ago(40 * DAY), caption: 'edited on the platform' });
    expect(planImportPage([listed], [own]).patches).toEqual([
      { postId: 'ours', patch: { publishAt: ago(40 * DAY) } },
    ]);
  });

  it('never overwrites a publish time or a caption of a post this app published', () => {
    const own = known('ours', { externalPostId: 'a', publishAt: ago(2 * DAY) });
    const listed = item('a', { publishedAt: ago(2 * DAY - 90_000), caption: 'different' });
    expect(planImportPage([listed], [own]).patches).toEqual([]);
  });

  it('recognises a Facebook video of ours by the id post() returned, not the listed one', () => {
    // /videos answers with the video id; the listing carries the feed story id and the video as
    // its attachment target.
    const own = known('ours', { externalPostId: '9001', publishAt: ago(DAY) });
    const listed = item('111_222', { alternateIds: ['9001'] });
    const plan = planImportPage([listed], [own]);
    expect(plan.inserts).toEqual([]);
    expect(plan.recognised).toEqual(['ours']);
  });

  it('recognises a post stored before the platform id was kept by its link, and fills both gaps', () => {
    const own = known('ours', {
      externalPostId: null,
      releaseUrl: 'https://www.facebook.com/111_222',
      publishAt: null,
    });
    const listed = item('111_222', {
      permalink: 'https://www.facebook.com/page/posts/pfbid0abc',
      knownUrls: ['https://www.facebook.com/111_222'],
    });
    const plan = planImportPage([listed], [own]);
    expect(plan.inserts).toEqual([]);
    expect(plan.patches).toEqual([
      { postId: 'ours', patch: { publishAt: listed.publishedAt, externalPostId: '111_222' } },
    ]);
  });

  it('prefers the post this app published when an imported copy matches too', () => {
    const imported = known('copy', { source: 'imported', externalPostId: 'a' });
    const own = known('ours', { externalPostId: 'a', publishAt: ago(DAY) });
    const plan = planImportPage([item('a')], [imported, own]);
    expect(plan.recognised).toEqual(['ours']);
    expect(plan.inserts).toEqual([]);
  });

  it('recognises but does not touch a post of ours that is not published', () => {
    const odd = known('ours', { status: 'failed', releaseUrl: 'https://platform.test/p/a' });
    const plan = planImportPage([item('a')], [odd]);
    expect(plan).toMatchObject({ inserts: [], patches: [], recognised: ['ours'] });
  });

  it('follows the platform for a post imported earlier: caption, link and time', () => {
    const before = known('row', {
      source: 'imported',
      externalPostId: 'a',
      caption: 'old caption',
      releaseUrl: 'https://platform.test/p/old',
      publishAt: ago(5 * DAY),
    });
    const listed = item('a', { caption: 'new caption', publishedAt: ago(3 * DAY) });
    expect(planImportPage([listed], [before]).patches).toEqual([
      {
        postId: 'row',
        patch: { caption: 'new caption', releaseUrl: listed.permalink, publishAt: ago(3 * DAY) },
      },
    ]);
  });

  it('clears a "removed on platform" mark when the platform lists the post again', () => {
    const marked = known('ours', {
      externalPostId: 'a',
      publishAt: ago(DAY),
      platformRemovedAt: ago(HOUR),
    });
    expect(planImportPage([item('a')], [marked]).patches).toEqual([
      { postId: 'ours', patch: { platformRemovedAt: null } },
    ]);
  });
});

describe('removalCandidates — which posts may be asked about', () => {
  const window = { since: ago(30 * DAY), until: ago(15 * MINUTE) };
  const row = (id: string, publishedAgo: number | null, over: Record<string, unknown> = {}) => ({
    id,
    status: 'published',
    externalPostId: `ext-${id}`,
    publishAt: publishedAgo === null ? null : ago(publishedAgo),
    platformRemovedAt: null as Date | null,
    createdAt: ago(publishedAgo ?? 2 * DAY),
    ...over,
  });

  it('offers a published post of the window that the list did not contain', () => {
    expect(removalCandidates([row('gone', 3 * DAY)], new Set(), window).map((p) => p.id)).toEqual([
      'gone',
    ]);
  });

  it('never offers a post the run recognised in the list', () => {
    expect(removalCandidates([row('here', 3 * DAY)], new Set(['here']), window)).toEqual([]);
  });

  it('never offers a post outside the window that was read — it was not looked for', () => {
    const rows = [row('older', 31 * DAY), row('too-new', 5 * MINUTE), row('edge', 30 * DAY)];
    expect(removalCandidates(rows, new Set(), window)).toEqual([]);
  });

  it('never offers a post already marked, without a platform id, or not published', () => {
    const rows = [
      row('marked', DAY, { platformRemovedAt: ago(HOUR) }),
      row('no-id', DAY, { externalPostId: null }),
      row('failed', DAY, { status: 'failed' }),
    ];
    expect(removalCandidates(rows, new Set(), window)).toEqual([]);
  });

  it('places a post with no publish time by when it was created', () => {
    const rows = [
      row('legacy-inside', null, { createdAt: ago(2 * DAY) }),
      row('legacy-outside', null, { createdAt: ago(200 * DAY) }),
    ];
    expect(removalCandidates(rows, new Set(), window).map((p) => p.id)).toEqual(['legacy-inside']);
  });

  it('asks about the newest first and never more than the limit', () => {
    const rows = [row('c', 9 * DAY), row('a', DAY), row('b', 4 * DAY)];
    expect(removalCandidates(rows, new Set(), window, 2).map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('readImportWindow — paging, the post limit and the rate limit', () => {
  const start = (): StoredImportState => ({
    ...queuedImportState(NOW, IMPORT_BACKFILL_DAYS),
    status: 'running',
    startedAt: NOW.toISOString(),
  });
  const ceiling = ago(15 * MINUTE);

  /** A platform holding `total` posts, one every hour going back, served `IMPORT_PAGE_SIZE` at a time. */
  function platform(
    total: number,
    usageAt: (page: number) => PublishedPostPage['usage'] = () => null,
  ) {
    const posts = Array.from({ length: total }, (_, n) =>
      item(`p${n}`, { publishedAt: ago((n + 1) * HOUR) }),
    );
    const list = vi.fn(async (query: { cursor?: string; limit: number }) => {
      const from = query.cursor ? Number(query.cursor) : 0;
      const to = from + query.limit;
      return {
        items: posts.slice(from, to),
        nextCursor: to < posts.length ? String(to) : null,
        usage: usageAt(from / query.limit),
      };
    });
    return { posts, list };
  }

  function harness(list: Parameters<typeof readImportWindow>[2]['list']) {
    const applied: string[] = [];
    const sleep = vi.fn(async () => {});
    const apply = vi.fn(async (items: PublishedPostItem[]) => {
      applied.push(...items.map((i) => i.externalPostId));
      return { imported: items.length, matched: 0, recognised: [] as string[] };
    });
    return { applied, sleep, apply, deps: { list, apply, sleep, now: () => NOW } };
  }

  it('persists progress after every page and continues unordered old pages', async () => {
    const list = vi.fn(async ({ cursor }: { cursor?: string }) =>
      cursor
        ? {
            items: [item('recent')],
            itemsRead: 25,
            orderedByPublishedAt: false,
            nextCursor: null,
            usage: null,
          }
        : {
            items: [item('old', { publishedAt: ago(100 * DAY) })],
            itemsRead: 25,
            orderedByPublishedAt: false,
            nextCursor: 'next',
            usage: null,
          },
    );
    const h = harness(list);
    const progress = vi.fn(async (_state: StoredImportState) => {});
    const read = await readImportWindow(start(), ceiling, { ...h.deps, progress });
    expect(h.applied).toEqual(['recent']);
    expect(
      progress.mock.calls.map(([state]) => [state.itemsRead, state.pages, state.imported]),
    ).toEqual([
      [25, 1, 0],
      [50, 2, 1],
    ]);
    expect(read.state).toMatchObject({ itemsRead: 50, pages: 2, imported: 1 });
  });

  it('resumes unordered inventory by cursor with its original ceiling, not its oldest publication', async () => {
    const h = harness(async () => ({
      items: [item('oldest', { publishedAt: ago(80 * DAY) })],
      orderedByPublishedAt: false,
      nextCursor: 'opaque-next',
      usage: { percent: 60, regainAccessMinutes: null },
    }));
    const first = await readImportWindow(start(), ceiling, h.deps);
    expect(first.state).toMatchObject({
      status: 'paused',
      unorderedCursor: 'opaque-next',
      until: ceiling.toISOString(),
    });
    const list = vi.fn(async (_query: { cursor?: string; until?: Date }) => ({
      items: [item('newer', { publishedAt: ago(DAY) })],
      orderedByPublishedAt: false,
      nextCursor: null,
      usage: null,
    }));
    const second = harness(list);
    const read = await readImportWindow(first.state, new Date(first.state.until!), second.deps);
    expect(list.mock.calls[0]?.[0]).toMatchObject({ cursor: 'opaque-next', until: ceiling });
    expect(second.applied).toEqual(['newer']);
    expect(read.state).toMatchObject({ pages: 2, imported: 2, unorderedCursor: undefined });
  });

  it('reads a window to its end in modest pages, pausing between them', async () => {
    const { list } = platform(60);
    const h = harness(list);
    const read = await readImportWindow(start(), ceiling, h.deps);

    expect(read.complete).toBe(true);
    expect(read.state).toMatchObject({ status: 'running', seen: 60, imported: 60, capped: false });
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls.every(([q]) => q.limit === IMPORT_PAGE_SIZE)).toBe(true);
    expect(IMPORT_PAGE_SIZE).toBeLessThanOrEqual(25);
    // A pause between pages, none after the last.
    expect(h.sleep).toHaveBeenCalledTimes(2);
    expect(h.sleep).toHaveBeenCalledWith(IMPORT_PAGE_DELAY_MS);
  });

  it('stops at the post limit and says so, keeping the newest posts', async () => {
    const { list, posts } = platform(IMPORT_MAX_POSTS_PER_RUN + 40);
    const h = harness(list);
    const read = await readImportWindow(start(), ceiling, h.deps);

    expect(read.complete).toBe(true);
    expect(read.state.capped).toBe(true);
    expect(read.state.seen).toBe(IMPORT_MAX_POSTS_PER_RUN);
    expect(read.state.message).toMatch(/Stopped at 500 posts/);
    expect(h.applied).toEqual(
      posts.slice(0, IMPORT_MAX_POSTS_PER_RUN).map((p) => p.externalPostId),
    );
  });

  it('is not capped by a window holding exactly as many posts as the limit allows', async () => {
    const { list } = platform(IMPORT_MAX_POSTS_PER_RUN);
    const read = await readImportWindow(start(), ceiling, harness(list).deps);
    expect(read.state).toMatchObject({ capped: false, seen: IMPORT_MAX_POSTS_PER_RUN });
  });

  it('pauses when the platform reports the usage threshold, and says where and when to continue', async () => {
    const { list, posts } = platform(200, (page) =>
      page === 1
        ? { percent: 62, regainAccessMinutes: null }
        : { percent: 5, regainAccessMinutes: null },
    );
    const h = harness(list);
    const read = await readImportWindow(start(), ceiling, h.deps);

    expect(read.complete).toBe(false);
    expect(list).toHaveBeenCalledTimes(2);
    expect(read.state).toMatchObject({ status: 'paused', seen: 50, resumed: true });
    expect(read.state.message).toMatch(/62% of the platform's rate limit/);
    expect(new Date(read.state.resumeAt!)).toEqual(new Date(NOW.getTime() + IMPORT_PAUSE_MS));
    // The posts read before the pause are kept, and the run continues from the oldest of them.
    expect(h.applied).toHaveLength(50);
    expect(new Date(read.state.until!)).toEqual(posts[49]!.publishedAt);
  });

  it('continues a paused run from where it stopped, counting on from what it had', async () => {
    const { list } = platform(30);
    const paused: StoredImportState = {
      ...start(),
      seen: 50,
      imported: 44,
      matched: 6,
      resumed: true,
    };
    const from = ago(50 * HOUR);
    const read = await readImportWindow(paused, from, harness(list).deps);

    expect(list.mock.calls[0]![0]).toMatchObject({ until: from });
    expect(read.state).toMatchObject({ seen: 50, imported: 44, matched: 6 });
    expect(read.complete).toBe(true);
  });

  it('does not treat usage on the last page as a reason to pause: there is nothing left to read', async () => {
    const { list } = platform(10, () => ({ percent: 95, regainAccessMinutes: null }));
    const read = await readImportWindow(start(), ceiling, harness(list).deps);
    expect(read).toMatchObject({ complete: true, state: { status: 'running' } });
  });

  it('treats being throttled as a pause, never a failure, and keeps what it read', async () => {
    const { list } = platform(80);
    list
      .mockImplementationOnce(list.getMockImplementation()!)
      .mockRejectedValueOnce(new ProviderRateLimitError('(#80001) too many calls [code 80001]'));
    const h = harness(list);
    const read = await readImportWindow(start(), ceiling, h.deps);

    expect(read).toMatchObject({ complete: false, authFailed: false });
    expect(read.state).toMatchObject({ status: 'paused', seen: 25, imported: 25 });
    expect(read.state.message).toMatch(/slow down/);
  });

  it('pauses on any transient platform error too', async () => {
    const list = vi.fn(async () => {
      throw new ProviderTransientError('upstream 502');
    });
    const read = await readImportWindow(start(), ceiling, harness(list).deps);
    expect(read.state.status).toBe('paused');
    // Nothing was read: continue from where this run started, not from "now".
    expect(new Date(read.state.until!)).toEqual(ceiling);
  });

  it('fails, and flags the connection, when the platform refuses the credentials', async () => {
    const list = vi.fn(async () => {
      throw new ProviderAuthError('token expired [code 190]');
    });
    const read = await readImportWindow(start(), ceiling, harness(list).deps);
    expect(read).toMatchObject({ complete: false, authFailed: true, state: { status: 'failed' } });
  });

  it('fails without flagging the connection for an error it does not understand', async () => {
    const list = vi.fn(async () => {
      throw new ProviderBadRequestError('(#100) nonexisting field');
    });
    const read = await readImportWindow(start(), ceiling, harness(list).deps);
    expect(read).toMatchObject({ authFailed: false, state: { status: 'failed' } });
    expect(read.state.message).toMatch(/nonexisting field/);
  });

  it('drops posts outside the window, and stops at a page wholly older than it', async () => {
    const state = { ...start(), since: ago(2 * DAY).toISOString() };
    const pages: PublishedPostPage[] = [
      {
        // The provider ignored `since`: one post inside, one too new, one too old.
        items: [
          item('too-new', { publishedAt: ago(MINUTE) }),
          item('inside', { publishedAt: ago(DAY) }),
          item('old', { publishedAt: ago(3 * DAY) }),
        ],
        nextCursor: 'next',
        usage: null,
      },
      { items: [item('older', { publishedAt: ago(9 * DAY) })], nextCursor: 'more', usage: null },
    ];
    const list = vi.fn(async () => pages.shift()!);
    const h = harness(list);
    const read = await readImportWindow(state, ceiling, h.deps);

    expect(h.applied).toEqual(['inside']);
    expect(list).toHaveBeenCalledTimes(2);
    expect(read).toMatchObject({ complete: true, state: { capped: false, seen: 1 } });
  });

  it('pauses rather than read for ever when the platform keeps offering pages', async () => {
    const list = vi.fn(async () => ({ items: [], nextCursor: 'again', usage: null }));
    const read = await readImportWindow(start(), ceiling, harness(list).deps);
    expect(list).toHaveBeenCalledTimes(IMPORT_MAX_PAGES_PER_RUN);
    expect(read.state.status).toBe('paused');
  });

  it('collects the stored posts each page recognised, for the removed-on-platform check', async () => {
    const { list } = platform(30);
    const h = harness(list);
    h.apply
      .mockResolvedValueOnce({ imported: 20, matched: 5, recognised: ['row-1', 'row-2'] })
      .mockResolvedValueOnce({ imported: 5, matched: 0, recognised: ['row-3'] });
    const read = await readImportWindow(start(), ceiling, h.deps);
    expect([...read.recognised]).toEqual(['row-1', 'row-2', 'row-3']);
    expect(read.state).toMatchObject({ imported: 25, matched: 5 });
  });
});

// Blog inventories include site drafts from years ago and site schedules in the future.
describe('whole blog import', () => {
  it('keeps out-of-window articles, refreshes metadata idempotently and never schedules them', async () => {
    const options = {
      kind: 'wordpress' as const,
      title: 'A blog draft',
      status: 'draft' as const,
      remote: {
        title: 'A blog draft',
        excerpt: '',
        slug: 'a-blog-draft',
        status: 'future' as const,
        modifiedAt: NOW.toISOString(),
        publishedAt: '2030-01-01T00:00:00.000Z',
        categories: ['News'],
        tags: ['Blog'],
        author: 'Editor',
        bodyFormat: 'html' as const,
        bodyTruncated: false,
      },
    };
    const articles = [
      item('old', { publishedAt: new Date('2000-01-01'), options }),
      item('future', { publishedAt: new Date('2030-01-01'), options }),
    ];
    const apply = vi.fn(async (items: PublishedPostItem[]) => ({
      imported: items.length,
      matched: 0,
      recognised: items.map((i) => i.externalPostId),
    }));
    const result = await readImportWindow(queuedImportState(NOW, 90), NOW, {
      wholeHistory: true,
      list: async () => ({ items: articles, nextCursor: null, usage: null }),
      apply,
      sleep: async () => {},
      now: () => NOW,
    });
    expect(result.state.imported).toBe(2);
    expect(result.complete).toBe(true);
    const plan = planImportPage(
      [articles[0]!],
      [
        known('stored', {
          source: 'imported',
          status: 'published',
          externalPostId: 'old',
          options: undefined,
        }),
      ],
    );
    expect(plan.inserts).toHaveLength(0);
    expect(plan.patches[0]!.patch.options).toEqual(options);
    expect(plan.patches[0]!.patch).not.toHaveProperty('status');
  });

  it('caps a whole blog at 500 and paces pages even outside the social date window', async () => {
    const apply = vi.fn(async (items: PublishedPostItem[]) => ({
      imported: items.length,
      matched: 0,
      recognised: [],
    }));
    const sleep = vi.fn(async () => {});
    let page = 0;
    const result = await readImportWindow(queuedImportState(NOW, 90), NOW, {
      wholeHistory: true,
      list: async () => ({
        items: Array.from({ length: IMPORT_PAGE_SIZE }, (_, i) =>
          item(`${page}-${i}`, { publishedAt: new Date('2000-01-01') }),
        ),
        nextCursor: String(++page),
        usage: null,
      }),
      apply,
      sleep,
      now: () => NOW,
    });
    expect(result.state.capped).toBe(true);
    expect(result.state.imported).toBe(IMPORT_MAX_POSTS_PER_RUN);
    expect(result.state.message).toContain('500');
    expect(sleep).toHaveBeenCalledWith(IMPORT_PAGE_DELAY_MS);
  });
});

it('whole blog imports retain the publishing settle guard and resume the numeric inventory cursor', async () => {
  const options = {
    kind: 'wordpress' as const,
    title: 'Recent article',
    status: 'publish' as const,
  };
  const start = { ...queuedImportState(NOW, 90), inventoryCursor: '4' };
  const list = vi.fn(async () => ({
    items: [item('just-sent', { options, publishedAt: new Date(NOW.getTime() + MINUTE) })],
    nextCursor: null,
    usage: null,
  }));
  const apply = vi.fn(async (items: PublishedPostItem[]) => ({
    imported: items.length,
    matched: 0,
    recognised: [],
  }));
  const result = await readImportWindow(start, NOW, {
    wholeHistory: true,
    list,
    apply,
    sleep: async () => {},
    now: () => NOW,
  });
  expect(list.mock.calls[0]![0]).toMatchObject({ cursor: '4' });
  expect(result.state.imported).toBe(0);
  expect(parseImportState(start)?.inventoryCursor).toBe('4');
});
