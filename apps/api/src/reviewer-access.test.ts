import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import * as core from '@meegrow-social/core';
import { buildServer } from './server.js';

vi.mock('@meegrow-social/core', async (original) => ({
  ...(await original<typeof core>()),
  authenticateApiKey: vi.fn(),
  authenticateSession: vi.fn(),
  recordApiRequestLog: vi.fn(),
  isWorkspaceMember: vi.fn(),
  switchActiveWorkspace: vi.fn(),
  createClientWorkspace: vi.fn(),
  addClientPerson: vi.fn(),
  listClientPeople: vi.fn(),
  removeClientPerson: vi.fn(),
  manageWorkspaceApiKeys: vi.fn(),
  getPost: vi.fn(),
  updatePost: vi.fn(),
  cancelPost: vi.fn(),
  retryPost: vi.fn(),
  getPostGroup: vi.fn(),
  duplicatePostGroup: vi.fn(),
  getMedia: vi.fn(),
  validateMediaAgainstPlatform: vi.fn(),
  getQueue: vi.fn(),
  updateQueue: vi.fn(),
  deleteQueue: vi.fn(),
  previewQueueSlots: vi.fn(),
  getConnectionHealth: vi.fn(),
  deleteConnection: vi.fn(),
  requestPostImport: vi.fn(),
  listConnections: vi.fn(),
  revokeConnectInvite: vi.fn(),
  finishConnect: vi.fn(),
  updateRemotePost: vi.fn(),
  trashRemotePost: vi.fn(),
  refreshRemotePost: vi.fn(),
  overviewForUser: vi.fn(),
  buildUserView: vi.fn(),
  getAnalyticsReportForUser: vi.fn(),
  queryEventLogs: vi.fn(),
  aggregateEventLogs: vi.fn(),
  getLatestPostMetrics: vi.fn(),
}));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const headers = { cookie: 'mg_sid=test-session', origin: 'http://localhost:8990' };
let app: FastifyInstance;
beforeAll(async () => {
  vi.stubEnv('MEDIA_STORAGE_DRIVER', 's3');
  app = await buildServer();
});
afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(core.authenticateSession).mockResolvedValue({
    workspaceId: A,
    userId: USER,
    sessionId: 'test-session',
    role: 'member',
  });
  vi.mocked(core.recordApiRequestLog).mockResolvedValue(undefined as never);
  vi.mocked(core.isWorkspaceMember).mockResolvedValue(false);
  vi.mocked(core.switchActiveWorkspace).mockResolvedValue(false);
  for (const fn of [
    core.createClientWorkspace,
    core.addClientPerson,
    core.listClientPeople,
    core.removeClientPerson,
    core.manageWorkspaceApiKeys,
  ])
    vi.mocked(fn).mockRejectedValue(new core.AccessDeniedError());
  for (const fn of [
    core.getPost,
    core.updatePost,
    core.retryPost,
    core.getPostGroup,
    core.getMedia,
    core.getQueue,
    core.updateQueue,
    core.getConnectionHealth,
  ])
    vi.mocked(fn).mockResolvedValue(null as never);
  for (const fn of [
    core.cancelPost,
    core.deleteQueue,
    core.deleteConnection,
    core.revokeConnectInvite,
  ])
    vi.mocked(fn).mockResolvedValue(false);
  vi.mocked(core.listConnections).mockResolvedValue([]);
  vi.mocked(core.duplicatePostGroup).mockResolvedValue(null);
  vi.mocked(core.previewQueueSlots).mockRejectedValue(new core.QueueNotFoundError('not found'));
  vi.mocked(core.requestPostImport).mockResolvedValue(null);
  vi.mocked(core.validateMediaAgainstPlatform).mockRejectedValue(new Error('media not found'));
  for (const fn of [core.updateRemotePost, core.trashRemotePost, core.refreshRemotePost])
    vi.mocked(fn).mockResolvedValue(null);
  vi.mocked(core.finishConnect).mockRejectedValue(new core.AccessDeniedError());
});
const inject = (options: InjectOptions) => app.inject({ ...options, headers });

describe('single-client member REST isolation', () => {
  it.each<InjectOptions>([
    { method: 'POST', url: '/v1/auth/session/workspace', payload: { workspaceId: B } },
    { method: 'POST', url: '/v1/workspaces', payload: { name: 'Escape' } },
    { method: 'GET', url: `/v1/workspaces/${B}/people` },
    {
      method: 'POST',
      url: `/v1/workspaces/${B}/people`,
      payload: { email: 'person@example.invalid', role: 'member' },
    },
    { method: 'DELETE', url: `/v1/workspaces/${B}/people/${FOREIGN}` },
    { method: 'GET', url: '/v1/api-keys' },
    { method: 'POST', url: '/v1/api-keys', payload: { name: 'Escape' } },
    { method: 'DELETE', url: `/v1/api-keys/${FOREIGN}` },
    { method: 'GET', url: `/v1/connections/invites?workspaceId=${B}` },
    { method: 'DELETE', url: `/v1/connections/invites/${FOREIGN}?workspaceId=${B}` },
    { method: 'POST', url: '/v1/connections/fake/invite', payload: { workspaceId: B } },
    {
      method: 'POST',
      url: '/v1/connections/finish',
      payload: { flowId: FOREIGN, externalId: 'foreign-account' },
    },
  ])('403s $method $url', async (options) => {
    expect((await inject(options)).statusCode).toBe(403);
  });

  it.each<InjectOptions>([
    { method: 'GET', url: `/v1/posts/${FOREIGN}` },
    { method: 'GET', url: `/v1/posts/${FOREIGN}/metrics` },
    { method: 'PATCH', url: `/v1/posts/${FOREIGN}`, payload: { caption: 'foreign edit' } },
    { method: 'DELETE', url: `/v1/posts/${FOREIGN}` },
    { method: 'POST', url: `/v1/posts/${FOREIGN}/retry` },
    { method: 'GET', url: `/v1/post-groups/${FOREIGN}` },
    { method: 'POST', url: `/v1/post-groups/${FOREIGN}/duplicate`, payload: {} },
    { method: 'POST', url: `/v1/posts/${FOREIGN}/remote/refresh`, payload: {} },
    {
      method: 'POST',
      url: `/v1/posts/${FOREIGN}/remote/update`,
      payload: { expectedModifiedAt: '2026-10-10T00:00:00.000Z', fields: { title: 'attempt' } },
    },
    {
      method: 'POST',
      url: `/v1/posts/${FOREIGN}/remote/trash`,
      payload: { expectedModifiedAt: '2026-10-10T00:00:00.000Z', confirm: true },
    },
    { method: 'GET', url: `/v1/media/${FOREIGN}` },
    { method: 'POST', url: `/v1/media/${FOREIGN}/validate`, payload: { provider: 'fake' } },
    { method: 'GET', url: `/v1/queues/${FOREIGN}` },
    { method: 'PATCH', url: `/v1/queues/${FOREIGN}`, payload: { name: 'foreign edit' } },
    { method: 'DELETE', url: `/v1/queues/${FOREIGN}` },
    { method: 'GET', url: `/v1/queues/${FOREIGN}/slots` },
    { method: 'GET', url: `/v1/connections/${FOREIGN}/health` },
    { method: 'DELETE', url: `/v1/connections/${FOREIGN}` },
    { method: 'POST', url: `/v1/connections/${FOREIGN}/import`, payload: {} },
    { method: 'GET', url: `/v1/connections/${FOREIGN}/followers` },
  ])('404s foreign id: $method $url, passing only active workspace A to core', async (options) => {
    const result = await inject(options);
    expect(result.statusCode).toBe(404);
    const delegated = [
      core.getPost,
      core.updatePost,
      core.cancelPost,
      core.retryPost,
      core.getPostGroup,
      core.getMedia,
      core.duplicatePostGroup,
      core.validateMediaAgainstPlatform,
      core.updateRemotePost,
      core.trashRemotePost,
      core.refreshRemotePost,
      core.getQueue,
      core.updateQueue,
      core.deleteQueue,
      core.previewQueueSlots,
      core.getConnectionHealth,
      core.deleteConnection,
      core.requestPostImport,
      core.listConnections,
    ].flatMap((fn) => vi.mocked(fn).mock.calls);
    expect(delegated.length).toBeGreaterThan(0);
    for (const call of delegated) {
      const scope = call[0];
      expect(typeof scope === 'object' && scope ? scope.workspaceId : scope).toBe(A);
    }
  });

  it('overview, session memberships and all-client analytics are keyed by user identity, never a supplied workspace', async () => {
    vi.mocked(core.overviewForUser).mockResolvedValue({
      clients: [{ workspaceId: A, name: 'Demo A' }],
    } as never);
    vi.mocked(core.buildUserView).mockResolvedValue({
      id: USER,
      memberships: [{ workspaceId: A, name: 'Demo A' }],
    } as never);
    vi.mocked(core.getAnalyticsReportForUser).mockResolvedValue({
      accounts: [{ workspaceId: A }],
    } as never);
    for (const url of ['/v1/overview', '/v1/auth/me', '/v1/analytics/report?scope=all']) {
      const response = await inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(B);
    }
    expect(core.overviewForUser).toHaveBeenCalledWith(USER);
    expect(core.buildUserView).toHaveBeenCalledWith(USER);
    expect(core.getAnalyticsReportForUser).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ scope: 'all' }),
    );
  });

  it('never lets an untrusted workspace query change logs or metrics scope', async () => {
    vi.mocked(core.queryEventLogs).mockResolvedValue({ entries: [] } as never);
    vi.mocked(core.aggregateEventLogs).mockResolvedValue({} as never);
    vi.mocked(core.getLatestPostMetrics).mockResolvedValue({} as never);
    for (const url of [
      `/v1/logs?workspaceId=${B}`,
      `/v1/logs/aggregate?workspaceId=${B}&from=2026-10-01&to=2026-10-12`,
    ])
      expect((await inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(
      (
        await inject({
          method: 'POST',
          url: '/v1/posts/metrics/latest',
          payload: { postIds: [FOREIGN], workspaceId: B },
        })
      ).statusCode,
    ).toBe(200);
    expect(core.queryEventLogs).toHaveBeenCalledWith(A, expect.anything());
    expect(core.aggregateEventLogs).toHaveBeenCalledWith(A, expect.anything());
    expect(core.getLatestPostMetrics).toHaveBeenCalledWith(A, [FOREIGN]);
  });
});

describe('owner people routes', () => {
  beforeEach(() => {
    vi.mocked(core.authenticateSession).mockResolvedValue({
      workspaceId: A,
      userId: USER,
      sessionId: 'test-session',
      role: 'owner',
    });
  });
  it('returns a temporary credential once with no-store, then lists only people fields', async () => {
    const person = {
      userId: FOREIGN,
      email: 'reviewer@example.invalid',
      name: null,
      role: 'member',
    };
    vi.mocked(core.addClientPerson).mockResolvedValue({
      person,
      temporaryPassword: '[TEST ONLY TEMPORARY PASSWORD]',
    });
    vi.mocked(core.listClientPeople).mockResolvedValue([person]);
    const response = await inject({
      method: 'POST',
      url: `/v1/workspaces/${A}/people`,
      payload: { email: person.email, role: 'member' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(vi.mocked(core.recordApiRequestLog).mock.calls)).not.toContain(
      '[TEST ONLY TEMPORARY PASSWORD]',
    );
    expect(core.addClientPerson).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
      A,
      { email: person.email, role: 'member' },
      expect.any(String),
    );
    const list = await inject({ method: 'GET', url: `/v1/workspaces/${A}/people` });
    expect(list.json()).toEqual({ people: [person] });
    expect(list.body).not.toContain('password');
  });
  it('reports duplicate email and rate-limit failures without credentials', async () => {
    const options = {
      method: 'POST' as const,
      url: `/v1/workspaces/${A}/people`,
      payload: { email: 'reviewer@example.invalid', role: 'member' },
    };
    vi.mocked(core.addClientPerson).mockRejectedValue(new core.PersonExistsError());
    expect((await inject(options)).statusCode).toBe(409);
    vi.mocked(core.addClientPerson).mockResolvedValue({ rateLimited: true, retryAfterSeconds: 30 });
    const limited = await inject(options);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('30');
  });
});

describe('viewer cannot mutate, including MCP and GET OAuth start', () => {
  it.each<InjectOptions>([
    { method: 'POST', url: '/v1/posts', payload: {} },
    { method: 'PATCH', url: `/v1/posts/${FOREIGN}`, payload: {} },
    { method: 'DELETE', url: `/v1/queues/${FOREIGN}` },
    { method: 'GET', url: '/v1/connections/fake/auth-url' },
    { method: 'GET', url: '/v1/connections/invites' },
    { method: 'POST', url: '/mcp', payload: {} },
  ])('403s $method $url before it reaches tenant services', async (options) => {
    vi.mocked(core.authenticateSession).mockResolvedValue({
      workspaceId: A,
      userId: USER,
      sessionId: 'test-session',
      role: 'viewer',
    });
    expect((await inject(options)).statusCode).toBe(403);
  });
});
