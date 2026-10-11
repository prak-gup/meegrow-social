import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analyticsReportQuery } from '@meegrow-social/contracts';
import {
  getAnalyticsReport,
  getConnectionFollowers,
  getPost,
  getPostMetrics,
  listConnections,
} from '@meegrow-social/core';
import type { AuthContext } from '@meegrow-social/core';
import { notFound, READ, respond } from './shared.js';

export function registerAnalyticsTools(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'post_metrics',
    {
      description:
        'Get the engagement metrics collected for one published post. `latest` is the newest ' +
        'value per metric name and `series` is the full history, oldest first. Metric names are ' +
        "the platform's own and differ per platform. Both are empty until the first collection " +
        'sweep after publishing. Read-only.',
      inputSchema: { postId: z.string().uuid() },
      annotations: READ,
    },
    (args) =>
      respond(async () => {
        const post = await getPost(ctx.workspaceId, args.postId);
        if (!post) throw notFound('post');
        return getPostMetrics(ctx.workspaceId, args.postId);
      }),
  );

  server.registerTool(
    'connection_followers',
    {
      description:
        'Get the follower-count history of one connected social account, newest first. Empty ' +
        'until the first collection sweep after the account is connected. Read-only.',
      inputSchema: { connectionId: z.string().uuid() },
      annotations: READ,
    },
    (args) =>
      respond(async () => {
        const connections = await listConnections(ctx.workspaceId);
        if (!connections.some((c) => c.id === args.connectionId)) throw notFound('connection');
        return getConnectionFollowers(ctx.workspaceId, args.connectionId);
      }),
  );

  server.registerTool(
    'analytics_report',
    {
      description:
        "How the workspace's published posts performed over a period, against the period before: " +
        'totals, engagement rate, per-platform and per-week breakdowns, best times to post, ' +
        'follower change, content formats and the top posts. Numbers are read as common concepts ' +
        '(views, reach, likes, comments, shares, saves, clicks, follows); `mapping` says which ' +
        "of each platform's own metric names is behind each, and a concept a platform does not " +
        'report is null, not 0. `rawMetrics` lists every native metric untouched. Engagement ' +
        'rate = (likes + comments + shares + saves) ÷ reach, ÷ views for a post without reach; ' +
        '`basis: "mixed"` means both were used. Totals are the all-time counts of the posts ' +
        'PUBLISHED in the period. Give `days` (default 30) or `from` + `to`. Read-only.',
      inputSchema: {
        days: z.number().int().min(1).max(366).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        provider: z.string().optional().describe('Only this platform, e.g. "instagram".'),
        connectionId: z.string().uuid().optional().describe('Only this connected account.'),
        source: z
          .enum(['app', 'imported'])
          .optional()
          .describe('`app`: published here. `imported`: found on the platform. Omitted = both.'),
        timezone: z
          .string()
          .optional()
          .describe('IANA zone weeks, days and posting hours are cut in. Default UTC.'),
        topPosts: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe('How many of the top posts to return, most engagements first. Default 20.'),
      },
      annotations: READ,
    },
    (args) =>
      respond(async () => {
        const { topPosts = 20, ...rest } = args;
        const report = await getAnalyticsReport(
          ctx.workspaceId,
          analyticsReportQuery.parse({ ...rest, scope: 'workspace' }),
        );
        const kept = report.topPosts.slice(0, topPosts);
        return {
          ...report,
          topPosts: kept,
          postsOmitted: report.postsOmitted + report.topPosts.length - kept.length,
        };
      }),
  );
}
