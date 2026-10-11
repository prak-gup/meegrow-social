import { z } from 'zod';

/**
 * Importing a connected account's existing posts — the ones published on the platform itself or
 * through another tool. The work runs in the worker; these shapes are what the API reports and
 * accepts. How it is decided lives in `core/services/post-import.ts`.
 */

/** Where a post came from: made in this app, or found on the platform and imported. */
export const postSource = z.enum(['app', 'imported']);
export type PostSource = z.infer<typeof postSource>;

/** How far back an "Import past posts" run may be asked to look. */
export const IMPORT_WINDOW_DAYS = [30, 90, 180, 365] as const;
/** The window of the import that runs by itself after an account is connected. */
export const DEFAULT_IMPORT_WINDOW_DAYS = 90;

export const importPostsInput = z.object({
  windowDays: z
    .union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)])
    .default(DEFAULT_IMPORT_WINDOW_DAYS),
});
export type ImportPostsInput = z.infer<typeof importPostsInput>;

/**
 * `queued`: asked for, not started. `running`: the worker is reading the platform. `paused`: it
 * stopped early to stay inside the platform's rate limit and continues by itself at `resumeAt`.
 * `done` / `failed`: how the last run ended.
 */
export const importStatus = z.enum(['queued', 'running', 'paused', 'done', 'failed']);
export type ImportStatus = z.infer<typeof importStatus>;

/** What a connection reports about importing its past posts. */
export const connectionImportView = z.object({
  /** False for a platform whose provider cannot list its posts; nothing is ever imported for it. */
  supported: z.boolean(),
  /** Null when no import was ever asked for. */
  status: importStatus.nullable(),
  /** `backfill`: a chosen window of history. `sync`: the periodic look for new posts. */
  kind: z.enum(['backfill', 'sync']).nullable(),
  windowDays: z.number().int().positive().nullable(),
  requestedAt: z.coerce.date().nullable(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  /** Set while `paused`: when the worker picks the run up again. */
  resumeAt: z.coerce.date().nullable(),
  /** Last time a run read the platform's list to its end. Null = never. */
  lastSyncedAt: z.coerce.date().nullable(),
  /** Posts the last run added. */
  imported: z.number().int().min(0),
  /** Posts the last run recognised as ones this app published (never duplicated). */
  matched: z.number().int().min(0),
  /** Posts the last run found to be gone from the platform. */
  removed: z.number().int().min(0),
  /** The run stopped at the per-run post limit; older posts in the window were not read. */
  capped: z.boolean(),
  /** One sentence for a person: why it paused or failed, or what was skipped. */
  message: z.string().nullable(),
});
export type ConnectionImportView = z.infer<typeof connectionImportView>;
