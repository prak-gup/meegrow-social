import { z } from 'zod';
import { providerIdentifier } from './providers.js';

/**
 * Control-tower overview (the redesigned home). A cross-client rollup over every workspace the
 * session user belongs to. Read-only; the operational answer to "what needs me, and how are my
 * clients doing this week".
 */

export const clientHealth = z.enum(['ok', 'warn', 'bad']);
export type ClientHealth = z.infer<typeof clientHealth>;

export const clientOverview = z.object({
  workspaceId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  health: clientHealth,
  connectionCount: z.number().int(),
  publishedThisWeek: z.number().int(),
  failedThisWeek: z.number().int(),
  nextPublishAt: z.coerce.date().nullable(),
  followers: z.number().nullable(),
  automationLive: z.boolean(),
});
export type ClientOverview = z.infer<typeof clientOverview>;

export const upcomingPost = z.object({
  workspaceId: z.string().uuid(),
  workspaceName: z.string(),
  provider: providerIdentifier,
  caption: z.string(),
  publishAt: z.coerce.date(),
});
export type UpcomingPost = z.infer<typeof upcomingPost>;

export const overviewView = z.object({
  generatedAt: z.coerce.date(),
  attention: z.object({
    failedPublishes: z.number().int(),
    needsReconnect: z.number().int(),
    tokensExpiring: z.number().int(),
    emptyQueues: z.number().int(),
  }),
  weekTotals: z.object({ publishedThisWeek: z.number().int() }),
  clients: z.array(clientOverview),
  upcoming: z.array(upcomingPost),
});
export type OverviewView = z.infer<typeof overviewView>;

/** POST /v1/workspaces — the "Add client" action. */
export const createWorkspaceInput = z.object({
  name: z.string().min(1).max(80),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInput>;

export const createdWorkspaceView = z.object({
  workspaceId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});
export type CreatedWorkspaceView = z.infer<typeof createdWorkspaceView>;
