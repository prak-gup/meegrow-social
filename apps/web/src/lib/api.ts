import type {
  AuthMeView,
  CalendarView,
  ConnectionView,
  CreatePostInput,
  MediaView,
  PostGroupView,
  PostView,
  QueueView,
  UpdatePostInput,
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

  // --- Connections (#2) ---
  listConnections: () => request<{ connections: ConnectionView[] }>('GET', '/v1/connections'),
  authUrl: (provider: string) =>
    request<{ url: string }>('GET', `/v1/connections/${encodeURIComponent(provider)}/auth-url`),
  finishConnect: (flowId: string, externalId: string) =>
    request<{ connectionId: string }>('POST', '/v1/connections/finish', { flowId, externalId }),
  deleteConnection: (id: string) => request<{ deleted: true }>('DELETE', `/v1/connections/${id}`),

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

  // --- Queues (#4) — composer queue picker ---
  listQueues: () => request<{ queues: QueueView[] }>('GET', '/v1/queues'),

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
