import type {
  ApiKeyView,
  AuthMeView,
  CalendarView,
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
  CreatedApiKeyView,
  PostMetricsView,
  FollowerSeriesView,
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
  createInvite: (provider: string) =>
    request<CreatedInviteView>('POST', `/v1/connections/${encodeURIComponent(provider)}/invite`),
  getInvite: (token: string) =>
    request<InviteView>('GET', `/v1/invite/${encodeURIComponent(token)}`),
  startInvite: (token: string) =>
    request<{ url: string }>('POST', `/v1/invite/${encodeURIComponent(token)}/start`),
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
  calendar: (year: number, month: number, timezone: string) =>
    request<CalendarView>('GET', '/v1/posts/calendar', undefined, { year, month, timezone }),
  getPostGroup: (id: string) => request<{ group: PostGroupView }>('GET', `/v1/post-groups/${id}`),

  // --- Analytics (#9, #28) ---
  // `capturedAt` arrives as an ISO string (responses are not run through the Zod parsers). The post
  // series is oldest first; the follower series is newest first.
  postMetrics: (id: string) =>
    request<PostMetricsView>('GET', `/v1/posts/${encodeURIComponent(id)}/metrics`),
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
