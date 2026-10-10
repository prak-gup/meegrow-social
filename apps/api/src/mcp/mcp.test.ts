import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as core from '@meegrow-social/core';
import { buildMcpServer } from './index.js';

/**
 * The MCP layer in isolation: a real MCP client talks to the real server over an in-memory
 * transport, with the `core` services replaced by spies. What is under test is everything this
 * layer owns — which tools exist, that each one hands core the KEY's workspace and the parsed
 * arguments, and that every failure comes back as a tool error. Real tenant isolation lives in
 * Postgres RLS and is covered by `../mcp.integration.test.ts`.
 */
vi.mock('@meegrow-social/core', async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  calendarPosts: vi.fn(),
  cancelPost: vi.fn(),
  createPost: vi.fn(),
  duplicatePost: vi.fn(),
  getConnectionFollowers: vi.fn(),
  getMedia: vi.fn(),
  getWorkspace: vi.fn(),
  listMedia: vi.fn(),
  getPost: vi.fn(),
  getPostGroup: vi.fn(),
  getPostMetrics: vi.fn(),
  listConnections: vi.fn(),
  listPosts: vi.fn(),
  listQueues: vi.fn(),
  registerMediaFromUrl: vi.fn(),
  updatePost: vi.fn(),
}));

const WS = '11111111-1111-4111-8111-111111111111';
const POST = '22222222-2222-4222-8222-222222222222';
const CONN = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const MEDIA = '55555555-5555-4555-8555-555555555555';
const QUEUE = '66666666-6666-4666-8666-666666666666';

const EXPECTED_TOOLS = [
  'add_to_queue',
  'calendar',
  'cancel_post',
  'connection_followers',
  'create_post',
  'delete_post',
  'duplicate_post',
  'get_connection',
  'get_media',
  'get_post',
  'get_post_group',
  'get_workspace',
  'list_connections',
  'list_media',
  'list_posts',
  'list_queues',
  'list_workspaces',
  'post_metrics',
  'register_media_from_url',
  'schedule_post',
  'unschedule_post',
  'update_post',
];

const READ_ONLY_TOOLS = [
  'calendar',
  'connection_followers',
  'get_connection',
  'get_media',
  'get_post',
  'get_post_group',
  'get_workspace',
  'list_connections',
  'list_media',
  'list_posts',
  'list_queues',
  'list_workspaces',
  'post_metrics',
];

async function connect(): Promise<Client> {
  const server = buildMcpServer({ workspaceId: WS, apiKeyId: 'key-1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

interface Outcome {
  isError: boolean;
  body: unknown;
  text: string;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Outcome> {
  const client = await connect();
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // The SDK's own input-validation errors are plain text, not JSON.
  }
  return { isError: result.isError === true, body, text };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('MCP tool surface', () => {
  it('exposes exactly the D1 tools', async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it('has no api-key management tool', async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.filter((t) => /key/i.test(t.name))).toEqual([]);
  });

  it('never lets the caller name a workspace', async () => {
    const { tools } = await (await connect()).listTools();
    for (const tool of tools) {
      const properties = Object.keys(tool.inputSchema.properties ?? {});
      expect(properties.filter((p) => /workspace/i.test(p))).toEqual([]);
    }
  });

  it('describes and annotates every tool, and marks exactly the read tools read-only', async () => {
    const { tools } = await (await connect()).listTools();
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
      expect(tool.annotations?.readOnlyHint).toBe(READ_ONLY_TOOLS.includes(tool.name));
    }
  });

  it('says so in the description of every tool that can publish', async () => {
    const { tools } = await (await connect()).listTools();
    const publishing = ['create_post', 'add_to_queue', 'schedule_post', 'update_post'];
    for (const tool of tools.filter((t) => publishing.includes(t.name))) {
      expect(tool.description).toMatch(/PUBLISHES/);
      expect(tool.annotations?.openWorldHint).toBe(true);
    }
    const del = tools.find((t) => t.name === 'delete_post')!;
    expect(del.description).toMatch(/CANCELS/);
    expect(del.description).toMatch(/does NOT hard-delete/);
    expect(del.description).toMatch(/removes nothing from the social network/);
    for (const name of ['cancel_post', 'delete_post']) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.description).toMatch(/IRREVERSIBL/);
      expect(tool.annotations?.destructiveHint).toBe(true);
    }
  });

  it('publishes dates in the input schema as ISO strings an agent can supply', async () => {
    const { tools } = await (await connect()).listTools();
    const schedule = tools.find((t) => t.name === 'schedule_post')!;
    expect(schedule.inputSchema.required).toEqual(['postId', 'publishAt']);
    expect(schedule.inputSchema.properties?.publishAt).toMatchObject({
      type: 'string',
      format: 'date-time',
    });
  });
});

describe('every tool calls core with the workspace of the key', () => {
  it('get_workspace and list_workspaces return the one workspace of the key', async () => {
    const workspace = { id: WS, name: 'Client A', slug: 'client-a' };
    vi.mocked(core.getWorkspace).mockResolvedValue(workspace);
    expect((await call('get_workspace')).body).toEqual(workspace);
    expect((await call('list_workspaces')).body).toEqual([workspace]);
    expect(core.getWorkspace).toHaveBeenCalledTimes(2);
    expect(core.getWorkspace).toHaveBeenCalledWith(WS);
  });

  it('the workspace tools ignore a workspace id smuggled into the arguments', async () => {
    vi.mocked(core.getWorkspace).mockResolvedValue({ id: WS, name: 'Client A', slug: 'client-a' });
    await call('get_workspace', { workspaceId: OTHER, id: OTHER });
    await call('list_workspaces', { workspaceId: OTHER });
    expect(vi.mocked(core.getWorkspace).mock.calls).toEqual([[WS], [WS]]);
  });

  it('list_media passes pagination through, with the contract defaults', async () => {
    vi.mocked(core.listMedia).mockResolvedValue([]);
    await call('list_media');
    expect(core.listMedia).toHaveBeenLastCalledWith(WS, { limit: 50, offset: 0 });
    await call('list_media', { limit: 5, offset: 10 });
    expect(core.listMedia).toHaveBeenLastCalledWith(WS, { limit: 5, offset: 10 });
  });

  it('list_connections', async () => {
    vi.mocked(core.listConnections).mockResolvedValue([]);
    expect((await call('list_connections')).body).toEqual([]);
    expect(core.listConnections).toHaveBeenCalledWith(WS);
  });

  it('get_connection returns the one asked for, with its health fields', async () => {
    const conn = { id: CONN, provider: 'fake', health: 'expiring', expiresInDays: 3 };
    vi.mocked(core.listConnections).mockResolvedValue([{ id: OTHER }, conn] as never);
    expect((await call('get_connection', { connectionId: CONN })).body).toEqual(conn);
    expect(core.listConnections).toHaveBeenCalledWith(WS);
  });

  it('list_posts passes the listPostsQuery filters through, parsed', async () => {
    vi.mocked(core.listPosts).mockResolvedValue([]);
    await call('list_posts', {
      status: 'scheduled',
      provider: 'fake',
      connectionId: CONN,
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-31T00:00:00Z',
      limit: 10,
      offset: 20,
    });
    expect(core.listPosts).toHaveBeenCalledWith(WS, {
      status: 'scheduled',
      provider: 'fake',
      connectionId: CONN,
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-31T00:00:00Z'),
      limit: 10,
      offset: 20,
    });
  });

  it('list_posts applies the contract defaults when called bare', async () => {
    vi.mocked(core.listPosts).mockResolvedValue([]);
    await call('list_posts');
    expect(core.listPosts).toHaveBeenCalledWith(WS, { limit: 50, offset: 0 });
  });

  it('get_post / get_post_group / get_media', async () => {
    vi.mocked(core.getPost).mockResolvedValue({ id: POST } as never);
    vi.mocked(core.getPostGroup).mockResolvedValue({ id: OTHER } as never);
    vi.mocked(core.getMedia).mockResolvedValue({ id: MEDIA } as never);
    expect((await call('get_post', { postId: POST })).body).toEqual({ id: POST });
    expect((await call('get_post_group', { groupId: OTHER })).body).toEqual({ id: OTHER });
    expect((await call('get_media', { mediaId: MEDIA })).body).toEqual({ id: MEDIA });
    expect(core.getPost).toHaveBeenCalledWith(WS, POST);
    expect(core.getPostGroup).toHaveBeenCalledWith(WS, OTHER);
    expect(core.getMedia).toHaveBeenCalledWith(WS, MEDIA);
  });

  it('update_post sends only the patch, never the id, as the patch', async () => {
    vi.mocked(core.updatePost).mockResolvedValue({ id: POST } as never);
    await call('update_post', { postId: POST, caption: 'edited' });
    expect(core.updatePost).toHaveBeenCalledWith(WS, POST, { caption: 'edited' });
  });

  it('schedule_post sets publishAt and unschedule_post clears it', async () => {
    vi.mocked(core.updatePost).mockResolvedValue({ id: POST } as never);
    await call('schedule_post', { postId: POST, publishAt: '2026-11-01T09:00:00+05:30' });
    expect(core.updatePost).toHaveBeenLastCalledWith(WS, POST, {
      publishAt: new Date('2026-11-01T03:30:00Z'),
    });
    await call('unschedule_post', { postId: POST });
    expect(core.updatePost).toHaveBeenLastCalledWith(WS, POST, { publishAt: null });
  });

  it('cancel_post and delete_post both cancel', async () => {
    vi.mocked(core.cancelPost).mockResolvedValue(true);
    expect((await call('cancel_post', { postId: POST })).body).toEqual({ cancelled: true });
    expect((await call('delete_post', { postId: POST })).body).toEqual({ cancelled: true });
    expect(core.cancelPost).toHaveBeenCalledTimes(2);
    expect(core.cancelPost).toHaveBeenCalledWith(WS, POST);
  });

  it('duplicate_post forwards the idempotency key', async () => {
    vi.mocked(core.duplicatePost).mockResolvedValue({ id: OTHER } as never);
    await call('duplicate_post', { postId: POST, idempotencyKey: 'dup-1' });
    expect(core.duplicatePost).toHaveBeenCalledWith(WS, POST, { idempotencyKey: 'dup-1' });
  });

  it('calendar', async () => {
    vi.mocked(core.calendarPosts).mockResolvedValue({ days: [] });
    await call('calendar', { year: 2026, month: 10, timezone: 'Asia/Kolkata' });
    expect(core.calendarPosts).toHaveBeenCalledWith(WS, {
      year: 2026,
      month: 10,
      timezone: 'Asia/Kolkata',
    });
  });

  it('list_queues / register_media_from_url', async () => {
    vi.mocked(core.listQueues).mockResolvedValue([]);
    vi.mocked(core.registerMediaFromUrl).mockResolvedValue({ id: MEDIA } as never);
    await call('list_queues');
    await call('register_media_from_url', { url: 'https://cdn.example/a.jpg', kind: 'image' });
    expect(core.listQueues).toHaveBeenCalledWith(WS);
    expect(core.registerMediaFromUrl).toHaveBeenCalledWith(WS, {
      url: 'https://cdn.example/a.jpg',
      kind: 'image',
    });
  });

  it('post_metrics checks the post exists in this workspace first', async () => {
    vi.mocked(core.getPost).mockResolvedValue({ id: POST } as never);
    vi.mocked(core.getPostMetrics).mockResolvedValue({ latest: { likes: 4 }, series: [] });
    expect((await call('post_metrics', { postId: POST })).body).toEqual({
      latest: { likes: 4 },
      series: [],
    });
    expect(core.getPost).toHaveBeenCalledWith(WS, POST);
    expect(core.getPostMetrics).toHaveBeenCalledWith(WS, POST);
  });

  it('connection_followers checks the connection exists in this workspace first', async () => {
    vi.mocked(core.listConnections).mockResolvedValue([{ id: CONN }] as never);
    vi.mocked(core.getConnectionFollowers).mockResolvedValue([]);
    await call('connection_followers', { connectionId: CONN });
    expect(core.getConnectionFollowers).toHaveBeenCalledWith(WS, CONN);
  });
});

describe('create_post / add_to_queue input', () => {
  const media = [{ mediaId: MEDIA, kind: 'image' }];

  it('accepts media and several variants, and defaults to a draft', async () => {
    vi.mocked(core.createPost).mockResolvedValue([]);
    const variants = [
      { connectionId: CONN, provider: 'fake' },
      { connectionId: OTHER, provider: 'instagram', caption: 'ig copy' },
    ];
    await call('create_post', { caption: 'hello', media, variants, idempotencyKey: 'k1' });
    expect(core.createPost).toHaveBeenCalledWith(
      WS,
      { caption: 'hello', media, variants, schedule: { type: 'draft' } },
      { idempotencyKey: 'k1' },
    );
  });

  it('passes an explicit schedule through', async () => {
    vi.mocked(core.createPost).mockResolvedValue([]);
    await call('create_post', {
      variants: [{ connectionId: CONN, provider: 'fake' }],
      schedule: { type: 'at', publishAt: '2026-11-01T09:00:00Z' },
    });
    expect(vi.mocked(core.createPost).mock.calls[0]?.[1].schedule).toEqual({
      type: 'at',
      publishAt: new Date('2026-11-01T09:00:00Z'),
    });
  });

  it('still accepts the single-target arguments it took before variants', async () => {
    vi.mocked(core.createPost).mockResolvedValue([]);
    await call('create_post', {
      caption: 'legacy',
      connectionId: CONN,
      provider: 'fake',
      publishAt: '2026-11-01T09:00:00Z',
    });
    expect(core.createPost).toHaveBeenCalledWith(
      WS,
      {
        caption: 'legacy',
        media: [],
        variants: [{ connectionId: CONN, provider: 'fake' }],
        schedule: { type: 'at', publishAt: new Date('2026-11-01T09:00:00Z') },
      },
      { idempotencyKey: undefined },
    );
  });

  it('rejects variants mixed with the shorthand, and a call naming no target', async () => {
    const mixed = await call('create_post', {
      variants: [{ connectionId: CONN, provider: 'fake' }],
      connectionId: CONN,
      provider: 'fake',
    });
    const none = await call('create_post', { caption: 'nowhere' });
    for (const outcome of [mixed, none]) {
      expect(outcome.isError).toBe(true);
      expect(outcome.body).toMatchObject({ error: 'invalid_request' });
    }
    expect(core.createPost).not.toHaveBeenCalled();
  });

  it('rejects `schedule` together with `publishAt`', async () => {
    const outcome = await call('create_post', {
      connectionId: CONN,
      provider: 'fake',
      schedule: { type: 'now' },
      publishAt: '2026-11-01T09:00:00Z',
    });
    expect(outcome.body).toMatchObject({ error: 'invalid_request' });
    expect(core.createPost).not.toHaveBeenCalled();
  });

  it('applies the contract rule that a youtube target needs options, on both input styles', async () => {
    const viaVariants = await call('create_post', {
      variants: [{ connectionId: CONN, provider: 'youtube' }],
    });
    const viaShorthand = await call('create_post', { connectionId: CONN, provider: 'youtube' });
    for (const outcome of [viaVariants, viaShorthand]) {
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toMatch(/require options/);
    }
    expect(core.createPost).not.toHaveBeenCalled();
  });

  it('add_to_queue schedules into the queue with media, variants and the key', async () => {
    vi.mocked(core.createPost).mockResolvedValue([]);
    await call('add_to_queue', {
      caption: 'queued',
      media,
      variants: [{ connectionId: CONN, provider: 'fake' }],
      queueId: QUEUE,
      idempotencyKey: 'q1',
    });
    expect(core.createPost).toHaveBeenCalledWith(
      WS,
      {
        caption: 'queued',
        media,
        variants: [{ connectionId: CONN, provider: 'fake' }],
        schedule: { type: 'queue', queueId: QUEUE },
      },
      { idempotencyKey: 'q1' },
    );
  });

  it('add_to_queue still accepts the single-target arguments', async () => {
    vi.mocked(core.createPost).mockResolvedValue([]);
    await call('add_to_queue', { connectionId: CONN, provider: 'fake', queueId: QUEUE });
    expect(vi.mocked(core.createPost).mock.calls[0]?.[1]).toMatchObject({
      variants: [{ connectionId: CONN, provider: 'fake' }],
      schedule: { type: 'queue', queueId: QUEUE },
    });
  });
});

describe('failures come back as tool errors, not thrown JSON-RPC errors', () => {
  it('not found: core returned nothing for that id', async () => {
    vi.mocked(core.getPost).mockResolvedValue(null);
    vi.mocked(core.getPostGroup).mockResolvedValue(null);
    vi.mocked(core.getMedia).mockResolvedValue(null);
    vi.mocked(core.updatePost).mockResolvedValue(null);
    vi.mocked(core.cancelPost).mockResolvedValue(false);
    vi.mocked(core.duplicatePost).mockResolvedValue(null);
    vi.mocked(core.listConnections).mockResolvedValue([{ id: OTHER }] as never);

    const outcomes = [
      await call('get_post', { postId: POST }),
      await call('get_post_group', { groupId: POST }),
      await call('get_media', { mediaId: MEDIA }),
      await call('update_post', { postId: POST, caption: 'x' }),
      await call('schedule_post', { postId: POST, publishAt: '2026-11-01T09:00:00Z' }),
      await call('unschedule_post', { postId: POST }),
      await call('cancel_post', { postId: POST }),
      await call('delete_post', { postId: POST }),
      await call('duplicate_post', { postId: POST }),
      await call('post_metrics', { postId: POST }),
      await call('get_connection', { connectionId: CONN }),
      await call('connection_followers', { connectionId: CONN }),
    ];
    for (const outcome of outcomes) {
      expect(outcome.isError).toBe(true);
      expect(outcome.body).toMatchObject({ error: 'not_found' });
    }
    // The existence check is what stops these two reading another workspace's series by id.
    expect(core.getPostMetrics).not.toHaveBeenCalled();
    expect(core.getConnectionFollowers).not.toHaveBeenCalled();
  });

  it('get_workspace is not_found if the workspace row is gone', async () => {
    vi.mocked(core.getWorkspace).mockResolvedValue(null);
    expect(await call('get_workspace')).toMatchObject({
      isError: true,
      body: { error: 'not_found' },
    });
    expect((await call('list_workspaces')).body).toEqual([]);
  });

  it('invalid state: editing or cancelling a published post (REST 409)', async () => {
    vi.mocked(core.updatePost).mockRejectedValue(
      new core.PostStateError("a 'published' post cannot be edited"),
    );
    vi.mocked(core.cancelPost).mockRejectedValue(
      new core.PostStateError("a 'published' post cannot be cancelled"),
    );
    expect(await call('update_post', { postId: POST, caption: 'x' })).toMatchObject({
      isError: true,
      body: { error: 'invalid_state', message: "a 'published' post cannot be edited" },
    });
    expect((await call('unschedule_post', { postId: POST })).body).toMatchObject({
      error: 'invalid_state',
    });
    expect((await call('cancel_post', { postId: POST })).body).toMatchObject({
      error: 'invalid_state',
      message: "a 'published' post cannot be cancelled",
    });
  });

  it('queue errors: unknown queue is not_found, inactive queue is invalid_request', async () => {
    const args = { connectionId: CONN, provider: 'fake', queueId: QUEUE };
    vi.mocked(core.createPost).mockRejectedValueOnce(
      new core.QueueNotFoundError('queue not found'),
    );
    expect(await call('add_to_queue', args)).toMatchObject({
      isError: true,
      body: { error: 'not_found', message: 'queue not found' },
    });
    vi.mocked(core.createPost).mockRejectedValueOnce(new core.QueueInactiveError('queue inactive'));
    expect((await call('add_to_queue', args)).body).toMatchObject({ error: 'invalid_request' });
  });

  it("a provider's own rule rejecting the post is invalid_request (REST 400)", async () => {
    vi.mocked(core.createPost).mockRejectedValue(
      new core.ProviderBadRequestError('youtube needs exactly one video'),
    );
    expect(await call('create_post', { connectionId: CONN, provider: 'fake' })).toMatchObject({
      isError: true,
      body: { error: 'invalid_request', message: 'youtube needs exactly one video' },
    });
  });

  it('anything else is internal_error with the message kept', async () => {
    vi.mocked(core.registerMediaFromUrl).mockRejectedValue(
      new Error('failed to fetch media from https://cdn.example/a.jpg: HTTP 404'),
    );
    expect(
      await call('register_media_from_url', { url: 'https://cdn.example/a.jpg' }),
    ).toMatchObject({
      isError: true,
      body: { error: 'internal_error', message: expect.stringContaining('HTTP 404') },
    });
  });

  it('malformed arguments are a tool error and never reach core', async () => {
    const badId = await call('get_post', { postId: 'not-a-uuid' });
    const badStatus = await call('list_posts', { status: 'sent' });
    const badLimit = await call('list_posts', { limit: 1000 });
    for (const outcome of [badId, badStatus, badLimit]) expect(outcome.isError).toBe(true);
    expect(core.getPost).not.toHaveBeenCalled();
    expect(core.listPosts).not.toHaveBeenCalled();
  });
});
