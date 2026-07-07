import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();
const workspaceId = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });

// --- Global (non-tenant-scoped) tables ---

export const workspaces = pgTable('workspaces', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  googleSub: text('google_sub'),
  name: text('name'),
  createdAt: createdAt(),
});

export const memberships = pgTable('memberships', {
  id: id(),
  workspaceId: workspaceId(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'), // owner | admin | member | viewer
  createdAt: createdAt(),
});

// --- Tenant-scoped tables (RLS-forced; see migrate.ts) ---

export const apiKeys = pgTable('api_keys', {
  id: id(),
  workspaceId: workspaceId(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(), // shown in UI, e.g. sk_live_abc123
  hash: text('hash').notNull(), // sha-256 of the full key
  scopes: text('scopes')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  lastUsedAt: ts('last_used_at'),
  expiresAt: ts('expires_at'),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
});

export const connections = pgTable('connections', {
  id: id(),
  workspaceId: workspaceId(),
  provider: text('provider').notNull(),
  externalId: text('external_id').notNull(), // page/org/channel/location id
  displayName: text('display_name').notNull(),
  accessToken: text('access_token'), // encrypted at rest
  refreshToken: text('refresh_token'), // encrypted at rest
  tokenModel: text('token_model').notNull().default('auto-refresh'),
  expiresAt: ts('expires_at'),
  needsReconnect: boolean('needs_reconnect').notNull().default(false),
  meta: jsonb('meta')
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});

export const media = pgTable('media', {
  id: id(),
  workspaceId: workspaceId(),
  kind: text('kind').notNull(), // image | video
  url: text('url'),
  s3Key: text('s3_key'),
  bytes: integer('bytes'),
  meta: jsonb('meta')
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});

export const postGroups = pgTable('post_groups', {
  id: id(),
  workspaceId: workspaceId(),
  caption: text('caption').notNull().default(''),
  media: jsonb('media')
    .notNull()
    .default(sql`'[]'::jsonb`),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

export const posts = pgTable('posts', {
  id: id(),
  workspaceId: workspaceId(),
  groupId: uuid('group_id')
    .notNull()
    .references(() => postGroups.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').notNull(),
  provider: text('provider').notNull(),
  status: text('status').notNull().default('draft'),
  caption: text('caption').notNull().default(''),
  media: jsonb('media')
    .notNull()
    .default(sql`'[]'::jsonb`),
  publishAt: ts('publish_at'),
  releaseUrl: text('release_url'),
  error: text('error'),
  idempotencyKey: text('idempotency_key'),
  createdAt: createdAt(),
});

export const queues = pgTable('queues', {
  id: id(),
  workspaceId: workspaceId(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  slots: jsonb('slots')
    .notNull()
    .default(sql`'[]'::jsonb`),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: id(),
  workspaceId: workspaceId(),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  events: text('events')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: id(),
  workspaceId: workspaceId(),
  endpointId: uuid('endpoint_id')
    .notNull()
    .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'), // pending | delivered | failed
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: ts('next_attempt_at'),
  createdAt: createdAt(),
});

export const metrics = pgTable('metrics', {
  id: id(),
  workspaceId: workspaceId(),
  postId: uuid('post_id'),
  connectionId: uuid('connection_id'),
  metric: text('metric').notNull(), // flexible key — survives impressions→views renames
  value: numeric('value').notNull(),
  capturedAt: ts('captured_at').notNull(),
  createdAt: createdAt(),
});

export const eventLogs = pgTable('event_logs', {
  id: id(),
  workspaceId: workspaceId(),
  kind: text('kind').notNull(), // api_request | publish | connection | webhook
  route: text('route'),
  status: text('status'),
  platform: text('platform'),
  account: text('account'),
  durationMs: integer('duration_ms'),
  message: text('message'),
  createdAt: createdAt(),
});

export const jobsDlq = pgTable('jobs_dlq', {
  id: id(),
  workspaceId: workspaceId(),
  queue: text('queue').notNull(),
  payload: jsonb('payload').notNull(),
  error: text('error'),
  createdAt: createdAt(),
});

/**
 * Client-data tables. migrate.ts ENABLEs + FORCEs RLS + creates a `workspace_id = app.workspace_id`
 * isolation policy on each, so even the table owner (dev superuser) cannot cross tenants.
 * Identity/routing tables (workspaces, users, memberships, api_keys) are intentionally NOT here:
 * they are read pre-tenant-context by the auth layer and hold no client social data. Tenant scoping
 * for those is enforced in the auth/core layer.
 */
export const TENANT_TABLES = [
  'connections',
  'media',
  'post_groups',
  'posts',
  'queues',
  'webhook_endpoints',
  'webhook_deliveries',
  'metrics',
  'event_logs',
  'jobs_dlq',
] as const;
