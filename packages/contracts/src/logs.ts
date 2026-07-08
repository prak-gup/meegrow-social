import { z } from 'zod';

/**
 * Observability surface (PRD F8). `event_logs` is a single flexible table fed by four sources:
 * the API request-logging hook (`api_request`) and the publish/connection/webhook services
 * (which already insert `kind: 'publish' | 'connection' | 'webhook'` rows — see core/services).
 */
export const eventLogKind = z.enum(['api_request', 'publish', 'connection', 'webhook']);
export type EventLogKind = z.infer<typeof eventLogKind>;

export const logEntryView = z.object({
  id: z.string().uuid(),
  kind: eventLogKind,
  route: z.string().nullable(),
  status: z.string().nullable(),
  platform: z.string().nullable(),
  account: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  message: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type LogEntryView = z.infer<typeof logEntryView>;

/** Query filters for `GET /v1/logs`. Cursor-based (keyset) pagination — opaque, base64 token. */
export const logsQueryInput = z.object({
  kind: eventLogKind.optional(),
  status: z.string().optional(),
  platform: z.string().optional(),
  route: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type LogsQueryInput = z.infer<typeof logsQueryInput>;

export const logsQueryResult = z.object({
  items: z.array(logEntryView),
  nextCursor: z.string().nullable(),
});
export type LogsQueryResult = z.infer<typeof logsQueryResult>;

/** Params for the aggregate endpoint — counts-by-status per time bucket over a window. */
export const logsAggregateInput = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  bucketMinutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(60),
  kind: eventLogKind.optional(),
  platform: z.string().optional(),
});
export type LogsAggregateInput = z.infer<typeof logsAggregateInput>;

export const logsAggregateBucket = z.object({
  bucketStart: z.coerce.date(),
  total: z.number().int(),
  errorCount: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
});
export type LogsAggregateBucket = z.infer<typeof logsAggregateBucket>;

export const logsAggregateResult = z.object({
  buckets: z.array(logsAggregateBucket),
});
export type LogsAggregateResult = z.infer<typeof logsAggregateResult>;
