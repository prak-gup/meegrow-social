import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { desc, eq, inArray } from 'drizzle-orm';
import { schema, withWorkspace, type Tx } from '@meegrow-social/db';
import {
  listMediaQuery,
  registerMediaFromUrlInput as registerMediaFromUrlSchema,
  type ListMediaQuery,
  type MediaKind,
  type MediaMeta,
  type MediaRef,
  type MediaValidationResult,
  type MediaView,
  type ProviderIdentifier,
  type RegisterMediaFromUrlInput,
} from '@meegrow-social/contracts';
import { getStorageDriver } from '../media/storage/index.js';
import { probeFile } from '../media/ffprobe.js';
import { validateMedia } from '../media/validate.js';

export interface UploadMediaInput {
  filename: string;
  contentType: string;
  data: Buffer;
}

const CONTENT_TYPE_CONTAINER: Record<string, { kind: MediaKind; container: string }> = {
  'image/jpeg': { kind: 'image', container: 'jpeg' },
  'image/jpg': { kind: 'image', container: 'jpeg' },
  'image/png': { kind: 'image', container: 'png' },
  'video/mp4': { kind: 'video', container: 'mp4' },
  'video/quicktime': { kind: 'video', container: 'mov' },
};

/** Classify a content-type into our kind + container. Trusted from the client (not ffprobe). */
function classify(contentType: string): { kind: MediaKind; container: string } {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const known = CONTENT_TYPE_CONTAINER[normalized];
  if (known) return known;
  if (normalized.startsWith('image/')) return { kind: 'image', container: normalized.slice(6) };
  if (normalized.startsWith('video/')) return { kind: 'video', container: normalized.slice(6) };
  throw new Error(`unsupported media content type: ${contentType}`);
}

/** ffprobe needs a path on disk — write to a scratch temp file regardless of storage backend. */
async function probeBuffer(data: Buffer, filenameForExt: string): Promise<MediaMeta> {
  const dir = await mkdtemp(join(tmpdir(), 'mgs-media-probe-'));
  const filePath = join(dir, `probe${extname(filenameForExt)}`);
  try {
    await writeFile(filePath, data);
    return await probeFile(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type MediaRow = typeof schema.media.$inferSelect;

function toView(row: MediaRow): MediaView {
  return {
    id: row.id,
    kind: row.kind as MediaKind,
    url: row.url,
    bytes: row.bytes,
    meta: (row.meta as MediaMeta) ?? {},
    createdAt: row.createdAt,
  };
}

/**
 * Store an uploaded file via the env-selected storage driver, probe it with ffprobe, and persist
 * the media row (PRD F3.3 / issue #3). Metadata capture never blocks on a target platform — the
 * platform-specific validate-and-reject check is a separate step (`validateMediaAgainstPlatform`).
 */
export async function uploadMedia(
  workspaceId: string,
  input: UploadMediaInput,
): Promise<MediaView> {
  const { kind, container } = classify(input.contentType);
  const stored = await getStorageDriver().put({
    workspaceId,
    filename: input.filename,
    contentType: input.contentType,
    data: input.data,
  });
  const probed = await probeBuffer(input.data, input.filename);
  const meta: MediaMeta = { ...probed, container, bytes: input.data.byteLength };

  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .insert(schema.media)
      .values({
        workspaceId,
        kind,
        url: stored.url,
        s3Key: stored.key,
        bytes: input.data.byteLength,
        meta,
      })
      .returning();
    if (!row) throw new Error('failed to persist media');
    return toView(row);
  });
}

export interface RegisterMediaFromUrlDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Register media that's already hosted elsewhere (antidote generates + hosts its own images) —
 * no re-upload to our storage, just fetch bytes long enough to probe them, then persist a media
 * row pointing at the original URL (acceptance criteria: "MCP tool to register media from an
 * external URL").
 */
export async function registerMediaFromUrl(
  workspaceId: string,
  rawInput: RegisterMediaFromUrlInput,
  deps: RegisterMediaFromUrlDeps = {},
): Promise<MediaView> {
  const input = registerMediaFromUrlSchema.parse(rawInput);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(input.url);
  if (!res.ok) throw new Error(`failed to fetch media from ${input.url}: HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const buffer = Buffer.from(await res.arrayBuffer());
  const { kind: detectedKind, container } = classify(contentType);
  const kind = input.kind ?? detectedKind;
  const probed = await probeBuffer(buffer, input.url);
  const meta: MediaMeta = { ...probed, container, bytes: buffer.byteLength };

  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .insert(schema.media)
      .values({
        workspaceId,
        kind,
        url: input.url,
        s3Key: null,
        bytes: buffer.byteLength,
        meta,
      })
      .returning();
    if (!row) throw new Error('failed to register media');
    return toView(row);
  });
}

export async function getMedia(workspaceId: string, mediaId: string): Promise<MediaView | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx.select().from(schema.media).where(eq(schema.media.id, mediaId)).limit(1);
    return row ? toView(row) : null;
  });
}

/**
 * One page of the workspace's media, newest first (D1 `list_media`). Ordered by createdAt then id
 * so offset pagination is deterministic. RLS scopes to this workspace — no explicit predicate.
 */
export async function listMedia(
  workspaceId: string,
  query: ListMediaQuery = listMediaQuery.parse({}),
): Promise<MediaView[]> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.media)
      .orderBy(desc(schema.media.createdAt), desc(schema.media.id))
      .limit(query.limit)
      .offset(query.offset);
    return rows.map(toView);
  });
}

/** Runs the pure per-platform spec check (media/validate.ts) against previously-captured meta. */
export async function validateMediaAgainstPlatform(
  workspaceId: string,
  mediaId: string,
  provider: ProviderIdentifier,
): Promise<MediaValidationResult> {
  const media = await getMedia(workspaceId, mediaId);
  if (!media) throw new Error(`media ${mediaId} not found`);
  return validateMedia(media.kind, media.meta, provider);
}

/**
 * Fill in missing public URLs on media refs from the media table. Posts may be created with only
 * a `mediaId` (no url yet); publish (PRD F3.3 — IG/GBP require public URLs) resolves them here,
 * inside the same RLS-scoped transaction the publish path already runs in.
 */
export async function resolveMediaRefs(tx: Tx, refs: MediaRef[]): Promise<MediaRef[]> {
  const missingIds = [...new Set(refs.filter((r) => !r.url).map((r) => r.mediaId))];
  if (missingIds.length === 0) return refs;
  const rows = await tx.select().from(schema.media).where(inArray(schema.media.id, missingIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return refs.map((r) => {
    if (r.url) return r;
    const row = byId.get(r.mediaId);
    if (!row?.url) throw new Error(`media ${r.mediaId} has no stored url`);
    return { ...r, url: row.url };
  });
}
