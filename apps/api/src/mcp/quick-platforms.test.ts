import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as core from '@meegrow-social/core';
import { buildMcpServer } from './index.js';

/**
 * Bluesky, Telegram, Discord and Slack through the MCP tools that already exist — no tool was
 * added for them, and none connects one (that is a human pasting a credential in the dashboard).
 * Same setup as mcp.test.ts: a real client, the real server, `core` replaced by spies.
 */
vi.mock('@meegrow-social/core', async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  createPost: vi.fn(),
  validatePost: vi.fn(),
}));

const WS = '11111111-1111-4111-8111-111111111111';
const CONN = '33333333-3333-4333-8333-333333333333';
const PROVIDERS = ['bluesky', 'telegram', 'discord', 'slack'] as const;

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

describe('the credential-connected platforms over MCP', () => {
  it.each(PROVIDERS)(
    'create_post takes a %s post through the single-target shorthand',
    async (provider) => {
      const outcome = await call('create_post', {
        caption: 'Open today — https://example.com',
        connectionId: CONN,
        provider,
        schedule: { type: 'now' },
      });
      expect(outcome.isError).toBe(false);
      expect(core.createPost).toHaveBeenCalledWith(
        WS,
        {
          caption: 'Open today — https://example.com',
          media: [],
          variants: [{ connectionId: CONN, provider }],
          schedule: { type: 'now' },
        },
        expect.anything(),
      );
    },
  );

  it('one call can address all four, each as its own variant', async () => {
    const variants = PROVIDERS.map((provider, i) => ({
      connectionId: `33333333-3333-4333-8333-33333333333${i}`,
      provider,
    }));
    const outcome = await call('create_post', { caption: 'hello', variants });
    expect(outcome.isError).toBe(false);
    expect(vi.mocked(core.createPost).mock.calls[0]?.[1]).toMatchObject({ variants });
  });

  it.each(PROVIDERS)('%s takes no per-platform options', async (provider) => {
    const outcome = await call('create_post', {
      caption: 'x',
      connectionId: CONN,
      provider,
      options: { kind: 'meta', format: 'feed' },
    });
    expect(outcome.isError).toBe(true);
    expect(JSON.parse(outcome.text)).toEqual({
      error: 'invalid_request',
      message: `variants.0.options: "${provider}" takes no per-platform options`,
    });
    expect(core.createPost).not.toHaveBeenCalled();
  });

  it('validate_post passes a platform’s own limit back as it was worded', async () => {
    vi.mocked(core.validatePost).mockResolvedValue({
      valid: false,
      issues: [
        {
          connectionId: CONN,
          provider: 'bluesky',
          code: 'not_publishable',
          message: 'The text is 301 characters; Bluesky takes at most 300',
        },
      ],
    });
    const outcome = await call('validate_post', {
      caption: 'a'.repeat(301),
      connectionId: CONN,
      provider: 'bluesky',
    });
    expect(outcome.text).toContain('The text is 301 characters; Bluesky takes at most 300');
  });

  it('offers no tool that connects an account or takes a credential', async () => {
    const { tools } = await (await connect()).listTools();
    const names = tools.map((t) => t.name);
    expect(
      names.some((n) => /connect_|credential|webhook/i.test(n) && n !== 'connection_health'),
    ).toBe(false);
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/appPassword|webhookUrl|botToken/);
    }
  });
});
