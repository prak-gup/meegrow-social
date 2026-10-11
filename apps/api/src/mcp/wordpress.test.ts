import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as core from '@meegrow-social/core';
import { buildMcpServer } from './index.js';

/**
 * A WordPress article through the MCP tools that already exist — no new tool was added for it.
 * Same setup as mcp.test.ts: a real client, the real server, `core` replaced by spies.
 */
vi.mock('@meegrow-social/core', async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  createPost: vi.fn(),
  updatePost: vi.fn(),
  validatePost: vi.fn(),
}));

const WS = '11111111-1111-4111-8111-111111111111';
const POST = '22222222-2222-4222-8222-222222222222';
const CONN = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

async function connect(): Promise<Client> {
  const server = buildMcpServer({ workspaceId: WS, apiKeyId: 'key-1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await (await connect()).callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  return { isError: result.isError === true, text };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(core.createPost).mockResolvedValue([]);
});

const options = { kind: 'wordpress', title: 'Five ways to cut plastic' };

describe('WordPress articles over MCP', () => {
  it('create_post takes an article through the single-target shorthand', async () => {
    const outcome = await call('create_post', {
      caption: '# Why\n\nBecause **plastic** lasts.',
      connectionId: CONN,
      provider: 'wordpress',
      options: { ...options, tags: ['plastic', 21], categories: ['Sustainability'] },
      schedule: { type: 'now' },
    });
    expect(outcome.isError).toBe(false);
    expect(core.createPost).toHaveBeenCalledWith(
      WS,
      {
        caption: '# Why\n\nBecause **plastic** lasts.',
        media: [],
        variants: [
          {
            connectionId: CONN,
            provider: 'wordpress',
            options: {
              kind: 'wordpress',
              title: 'Five ways to cut plastic',
              tags: ['plastic', 21],
              categories: ['Sustainability'],
              status: 'publish',
            },
          },
        ],
        schedule: { type: 'now' },
      },
      { idempotencyKey: undefined },
    );
  });

  it('create_post takes a long body on the variant, beside a short social caption', async () => {
    const body = 'word '.repeat(4000); // 20 000 characters
    const outcome = await call('create_post', {
      caption: 'New on the blog: five ways to cut plastic.',
      variants: [
        { connectionId: CONN, provider: 'wordpress', caption: body, options },
        { connectionId: OTHER, provider: 'fake' },
      ],
    });
    expect(outcome.isError).toBe(false);
    const [, input] = vi.mocked(core.createPost).mock.calls[0]!;
    expect(input.variants[0]!.caption).toHaveLength(20_000);
    expect(input.variants[1]!.caption).toBeUndefined();
    expect(input.caption).toBe('New on the blog: five ways to cut plastic.');
  });

  it('rejects an article without a title, and a body too long for a social variant', async () => {
    const untitled = await call('create_post', { connectionId: CONN, provider: 'wordpress' });
    expect(untitled.isError).toBe(true);
    expect(untitled.text).toMatch(/require options/);

    const tooLong = await call('create_post', {
      variants: [{ connectionId: OTHER, provider: 'fake', caption: 'a'.repeat(5001) }],
    });
    expect(tooLong.isError).toBe(true);
    const longTopLevel = await call('create_post', {
      caption: 'a'.repeat(5001),
      connectionId: CONN,
      provider: 'wordpress',
      options,
    });
    expect(longTopLevel.isError).toBe(true);
    expect(core.createPost).not.toHaveBeenCalled();
  });

  it('does not offer WordPress’s own scheduling status', async () => {
    const outcome = await call('create_post', {
      connectionId: CONN,
      provider: 'wordpress',
      options: { ...options, status: 'future' },
    });
    expect(outcome.isError).toBe(true);
    expect(core.createPost).not.toHaveBeenCalled();
  });

  it('update_post passes a long article body on for core to judge against the stored post', async () => {
    vi.mocked(core.updatePost).mockResolvedValue(null);
    await call('update_post', { postId: POST, caption: 'a'.repeat(20_000), options });
    const [, , patch] = vi.mocked(core.updatePost).mock.calls[0]!;
    expect(patch.caption).toHaveLength(20_000);
    expect(patch.options).toMatchObject({ kind: 'wordpress', status: 'publish' });
  });

  it('describes the article rules where an agent reads them: on the tool', async () => {
    const { tools } = await (await connect()).listTools();
    const createPost = tools.find((t) => t.name === 'create_post')!;
    const schema = JSON.stringify(createPost.inputSchema);
    expect(schema).toContain('wordpress');
    expect(schema).toContain('Markdown');
    expect(schema).toContain('100000');
  });
});
