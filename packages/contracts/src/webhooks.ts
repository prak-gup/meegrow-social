import { z } from 'zod';

export const webhookEventType = z.enum([
  'post.published',
  'post.failed',
  'connection.needs_reconnect',
  'analytics.updated',
]);
export type WebhookEventType = z.infer<typeof webhookEventType>;

export const webhookEvent = z.object({
  id: z.string().uuid(),
  type: webhookEventType,
  workspaceId: z.string().uuid(),
  createdAt: z.coerce.date(),
  data: z.record(z.unknown()),
});
export type WebhookEvent = z.infer<typeof webhookEvent>;
