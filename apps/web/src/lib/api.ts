import type {
  ApiKeyView,
  AuthMeView,
  CalendarView,
  ConnectCredentialsResult,
  ConnectionView,
  CreatePostInput,
  MediaView,
  PostGroupView,
  PostView,
  ProviderView,
  QueueSlotsView,
  QueueView,
  UpdatePostInput,
  OverviewView,
  CreatedWorkspaceView,
  CreatedInviteView,
  InviteView,
  InviteFlowView,
  InviteConnectedView,
  OutstandingInviteView,
  CreatedApiKeyView,
  PostMetricsView,
  FollowerSeriesView,
  PostGroupSummary,
  ConnectionImportView,
  PostValidationResult,
  BulkPostMetricsView,
  AnalyticsStatusView,
  AnalyticsReportView,
  PasswordConnectResult,
  SiteCheck,
} from '@meegrow-social/contracts';

/**
 * The ONLY place the dashboard talks to the network (AX-PRD §3.5: zero fetch outside the typed API
 * client). Cookie-authed (`credentials: include`) so the session works same-origin via Caddy, and
 * in dev via the Vite proxy. Every response is typed off the shared `contracts` package.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | undefined>;

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const url = query
    ? `${path}?${new URLSearchParams(
        Object.fromEntries(
          Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][],
        ),
      )}`
    : path;
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message =
      typeof data === 'object' &&
      data &&
      'error' in data &&
      typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : res.statusText;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const api = {
  // --- Auth (#10) ---
  login: (email: string, password: string) =>
    request<AuthMeView>('POST', '/v1/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/v1/auth/logout'),
  me: () => request<AuthMeView>('GET', '/v1/auth/me'),
  switchWorkspace: (workspaceId: string) =>
    request<{ activeWorkspaceId: string }>('POST', '/v1/auth/session/workspace', { workspaceId }),
  rotateSession: () => request<{ ok: true }>('POST', '/v1/auth/session/rotate'),
  // Signs the user out everywhere else; this browser keeps its (re-issued) session cookie.
  // Callers must not persist or log either password.
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/v1/auth/password', { currentPassword, newPassword }),

  // --- Overview + workspaces (redesign) ---
  overview: () => request<OverviewView>('GET', '/v1/overview'),
  createWorkspace: (name: string) =>
    request<CreatedWorkspaceView>('POST', '/v1/workspaces', { name }),

  // --- Connections (#2) ---
  /** Platforms registered in this environment — fakes in dev, real providers in prod (#45). */
  listProviders: () => request<{ providers: ProviderView[] }>('GET', '/v1/providers'),
  listConnections: () => request<{ connections: ConnectionView[] }>('GET', '/v1/connections'),
  authUrl: (provider: string) =>
    request<{ url: string }>('GET', `/v1/connections/${encodeURIComponent(provider)}/auth-url`),
  /**
   * Start connecting a provider that asks for something first (`connectInput` on the provider) —
   * WordPress needs the site's address. The server validates it and answers with where to go.
   */
  startConnect: (provider: string, answers: { siteUrl?: string }) =>
    request<{ url: string }>(
      'POST',
      `/v1/connections/${encodeURIComponent(provider)}/start`,
      answers,
    ),
  /**
   * Ask the server to look at a site address without logging in: which connect methods the site
   * can use, why not when it cannot, and — when a login is possible — the exact address it would
   * be sent to, sealed in `ticket`.
   */
  checkSite: (provider: string, siteUrl: string) =>
    request<SiteCheck>('POST', `/v1/connections/${encodeURIComponent(provider)}/site-check`, {
      siteUrl,
    }),
  /**
   * Connect a site with a username and LOGIN password, for the endpoint a `checkSite` ticket
   * names. Sent once, over this app's own https. Callers must not persist or log the password;
   * the response never carries it.
   */
  connectWithPassword: (
    provider: string,
    login: { ticket: string; username: string; password: string },
  ) =>
    request<PasswordConnectResult>(
      'POST',
      `/v1/connections/${encodeURIComponent(provider)}/password`,
      login,
    ),
  /**
   * Connect a provider that takes a pasted credential (`connectInput: 'credentials'`). The server
   * verifies it against the platform and stores it; the answer never repeats it. Callers must not
   * persist or log `fields`.
   */
  connectCredentials: (provider: string, fields: Record<string, string>) =>
    request<ConnectCredentialsResult>(
      'POST',
      `/v1/connections/${encodeURIComponent(provider)}/credentials`,
      { fields },
    ),
  /** Mints for the active client, or for `workspaceId` — any client the user belongs to. */
  createInvite: (provider: string, workspaceId?: string) =>
    request<CreatedInviteView>(
      'POST',
      `/v1/connections/${encodeURIComponent(provider)}/invite`,
      workspaceId ? { workspaceId } : undefined,
    ),
  /** The links that still work for the active client, or for `workspaceId`. */
  listInvites: (workspaceId?: string) =>
    request<{ invites: OutstandingInviteView[] }>('GET', '/v1/connections/invites', undefined, {
      workspaceId,
    }),
  revokeInvite: (id: string, workspaceId?: string) =>
    request<{ revoked: true }>(
      'DELETE',
      `/v1/connections/invites/${encodeURIComponent(id)}`,
      undefined,
      { workspaceId },
    ),
  getInvite: (token: string) =>
    request<InviteView>('GET', `/v1/invite/${encodeURIComponent(token)}`),
  /** `siteUrl` only for an invite whose `connectInput` is `site_url` (WordPress). */
  startInvite: (token: string, siteUrl?: string) =>
    request<{ url: string }>(
      'POST',
      `/v1/invite/${encodeURIComponent(token)}/start`,
      siteUrl ? { siteUrl } : undefined,
    ),
  // The invite's account pick (public): the flow's HttpOnly proof cookie is the credential.
  getInviteFlow: (flowId: string) =>
    request<InviteFlowView>('GET', `/v1/invite/flow/${encodeURIComponent(flowId)}`),
  finishInviteFlow: (flowId: string, externalId: string) =>
    request<InviteConnectedView>('POST', `/v1/invite/flow/${encodeURIComponent(flowId)}/finish`, {
      externalId,
    }),
  finishConnect: (flowId: string, externalId: string) =>
    request<{ connectionId: string }>('POST', '/v1/connections/finish', { flowId, externalId }),
  deleteConnection: (id: string) => request<{ deleted: true }>('DELETE', `/v1/connections/${id}`),
  /**
   * Queue a read of the account's existing posts for the last `windowDays` (30, 90, 180 or 365).
   * Answers at once; progress is `import` on `listConnections`. Reads the platform only — nothing
   * is posted. Asking while a run is queued or under way changes nothing and returns that run.
   */
  importPastPosts: (id: string, windowDays: number) =>
    request<{ import: ConnectionImportView }>(
      'POST',
      `/v1/connections/${encodeURIComponent(id)}/import`,
      { windowDays },
    ),

  // --- API keys (#8) ---
  // Scoped to the session's active workspace. The create response is the only one carrying the
  // secret; callers must not persist or log it.
  listApiKeys: () => request<{ apiKeys: ApiKeyView[] }>('GET', '/v1/api-keys'),
  createApiKey: (name: string) => request<CreatedApiKeyView>('POST', '/v1/api-keys', { name }),
  revokeApiKey: (id: string) =>
    request<{ revoked: true }>('DELETE', `/v1/api-keys/${encodeURIComponent(id)}`),

  // --- Posts (#5) ---
  // Filter values are sent as URL params (the server validates via listPostsQuery); the response is
  // typed off PostView. Dates are passed as ISO strings.
  listPosts: (
    query: {
      status?: string;
      provider?: string;
      connectionId?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => request<{ posts: PostView[] }>('GET', '/v1/posts', undefined, query),
  getPost: (id: string) => request<{ post: PostView }>('GET', `/v1/posts/${id}`),
  updatePost: (id: string, patch: UpdatePostInput) =>
    request<{ post: PostView }>('PATCH', `/v1/posts/${id}`, patch),
  cancelPost: (id: string) => request<{ cancelled: true }>('DELETE', `/v1/posts/${id}`),
  createPost: (input: CreatePostInput) =>
    request<{ posts: PostView[] }>('POST', '/v1/posts', input),
  // Dry run of createPost: same body, nothing created, always 200. `issues` names what create (or
  // the publish after it) would reject, per account where it belongs to one.
  validatePost: (input: CreatePostInput) =>
    request<PostValidationResult>('POST', '/v1/posts/validate', input),
  calendar: (year: number, month: number, timezone: string) =>
    request<CalendarView>('GET', '/v1/posts/calendar', undefined, { year, month, timezone }),
  getPostGroup: (id: string) => request<{ group: PostGroupView }>('GET', `/v1/post-groups/${id}`),
  // One item per composed post, with every per-platform post in it. `limit`/`offset` count groups,
  // so a multi-platform post is never split across two pages. Filters apply to the variants.
  listPostGroups: (
    query: {
      status?: string;
      source?: string;
      provider?: string;
      connectionId?: string;
      from?: string;
      to?: string;
      q?: string;
      order?: 'asc' | 'desc';
      limit?: number;
      offset?: number;
    } = {},
  ) => request<{ groups: PostGroupSummary[] }>('GET', '/v1/post-groups', undefined, query),
  /** Copies every variant into a new group of drafts. Publishes nothing. */
  duplicatePostGroup: (id: string) =>
    request<{ group: PostGroupSummary }>(
      'POST',
      `/v1/post-groups/${encodeURIComponent(id)}/duplicate`,
    ),
  /** Queues a `failed` post again: it PUBLISHES for real, now or at its still-future time. */
  retryPost: (id: string) =>
    request<{ post: PostView }>('POST', `/v1/posts/${encodeURIComponent(id)}/retry`),

  // --- Analytics (#9, #28) ---
  // `capturedAt` arrives as an ISO string (responses are not run through the Zod parsers). The post
  // series is oldest first; the follower series is newest first.
  postMetrics: (id: string) =>
    request<PostMetricsView>('GET', `/v1/posts/${encodeURIComponent(id)}/metrics`),
  // Newest value per metric name for up to 200 posts (BULK_METRICS_MAX_POSTS). An id that is not a
  // post of this workspace has no entry; a post with nothing collected has an empty `latest`.
  latestPostMetrics: (postIds: string[]) =>
    request<BulkPostMetricsView>('POST', '/v1/posts/metrics/latest', { postIds }),
  analyticsStatus: () => request<AnalyticsStatusView>('GET', '/v1/analytics/status'),
  // The whole Analytics screen in one read, computed by core: totals against the prior period,
  // breakdowns, best times, top posts. `timezone` is the viewer's; `scope: 'all'` adds up every
  // client the user belongs to. Dates arrive as ISO strings.
  analyticsReport: (query: Query) =>
    request<AnalyticsReportView>('GET', '/v1/analytics/report', undefined, query),
  connectionFollowers: (id: string) =>
    request<FollowerSeriesView>('GET', `/v1/connections/${encodeURIComponent(id)}/followers`),

  // --- Queues (#4) — composer queue picker ---
  listQueues: () => request<{ queues: QueueView[] }>('GET', '/v1/queues'),
  // The next `count` (1–50) times the queue would hand out; a snapshot, nothing is reserved. May
  // hold fewer than asked. 404 for an unknown queue, 400 for an inactive one.
  queueSlots: (id: string, count: number) =>
    request<QueueSlotsView>('GET', `/v1/queues/${encodeURIComponent(id)}/slots`, undefined, {
      count,
    }),

  // --- Media (#3) ---
  uploadMedia: async (file: File): Promise<MediaView> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/v1/media', { method: 'POST', credentials: 'include', body: form });
    const data = (await res.json()) as {
      mediaId: string;
      url: string;
      kind: string;
      meta: unknown;
    };
    if (!res.ok) throw new ApiError(res.status, 'media upload failed');
    return {
      id: data.mediaId,
      url: data.url,
      kind: data.kind as 'image' | 'video',
      meta: data.meta,
    } as MediaView;
  },
};
