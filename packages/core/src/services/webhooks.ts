import { schema, withWorkspace } from '@meegrow-social/db';
import { eq } from 'drizzle-orm';

/**
 * Webhook OUTBOX (issue #12). This module only PRODUCES `webhook_deliveries` rows; the
 * signed-delivery drainer (HMAC svix-compatible headers + backoff + DLQ/replay) is issue #6, which
 * will consume the `pending` rows written here. Decoupling lets #12 ship the
 * `connection.needs_reconnect` event before the delivery worker exists.
 */
export const CONNECTION_NEEDS_RECONNECT_EVENT = 'connection.needs_reconnect';
/** Emitted per post whose analytics sweep collected fresh metrics (#9). */
export const ANALYTICS_UPDATED_EVENT = 'analytics.updated';

/** A tx handle from `withWorkspace`. */
type Tx = Parameters<Parameters<typeof withWorkspace>[1]>[0];

/**
 * Insert a `pending` webhook_delivery row for every ACTIVE endpoint subscribed to `eventType`
 * (subscription = its `events` array contains the event OR the wildcard `'*'`), on the given tx so
 * the enqueue is atomic with the state change that produced the event. No-op when nothing matches.
 */
export async function enqueueDeliveriesInTx(
  tx: Tx,
  workspaceId: string,
  eventType: string,
  payload: unknown,
): Promise<void> {
  const endpoints = await tx
    .select()
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.active, true));
  const subscribed = endpoints.filter(
    (e) => e.events.includes(eventType) || e.events.includes('*'),
  );
  if (subscribed.length === 0) return;
  await tx.insert(schema.webhookDeliveries).values(
    subscribed.map((e) => ({
      workspaceId,
      endpointId: e.id,
      eventType,
      payload,
      status: 'pending' as const,
    })),
  );
}

/**
 * Standalone wrapper for callers not already inside a `withWorkspace` tx — opens its own tenant
 * transaction. Issue #6's delivery drainer and future event emitters use this.
 */
export async function enqueueWebhookDelivery(
  workspaceId: string,
  eventType: string,
  payload: unknown,
): Promise<void> {
  return withWorkspace(workspaceId, (tx) =>
    enqueueDeliveriesInTx(tx, workspaceId, eventType, payload),
  );
}
