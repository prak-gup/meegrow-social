import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, schema, withWorkspace } from '@meegrow-social/db';
import {
  createWorkspace,
  resetDb,
  useRecordingScheduler,
  useTestDatabaseEnv,
} from '@meegrow-social/testing';
import { decryptToken } from '../crypto.js';
import { ProviderAuthError, ProviderBadRequestError, ProviderTransientError } from '../errors.js';
import { FakeProvider } from '../providers/fake.js';
import { registerProvider } from '../providers/registry.js';
import { CredentialFormatError } from '../providers/shared/http.js';
import type {
  AuthTokens,
  GenerateAuthUrl,
  MetricPoint,
  PostDetails,
  PostResult,
  SocialProvider,
} from '../providers/types.js';
import { AUTH_ATTEMPT_LIMITS, resetAttemptStore } from './auth-throttle.js';
import { listConnections } from './connections.js';
import { connectWithCredentials } from './credential-connect.js';
import { createPost } from './posts.js';

/**
 * `connectWithCredentials` against real Postgres, with a stand-in provider: what is stored and
 * how, that a second connect replaces the credential in place, tenant isolation, and the attempt
 * limit. The four real providers each have their own file next to this one.
 *
 * NEVER EXECUTED BY ITS AUTHOR: this file was written without access to a database (the build
 * that added it was forbidden to connect to one). CI is its first run.
 */

const SECRET = 'tok_live_SECRET_0123456789';
const IP = '203.0.113.7';

/** What the stand-in platform does with the next credential it is shown. */
let verdict: (fields: Readonly<Record<string, string>>) => AuthTokens;
let asked = 0;

/** `fake`, re-registered as a platform that connects with a pasted credential. */
class PastedCredentialProvider implements SocialProvider {
  readonly identifier = 'fake' as const;
  readonly displayName = 'Pasted Credential Platform';
  readonly isBetweenSteps = false;
  readonly tokenModel = 'one-time' as const;
  readonly maxConcurrentJobs = 1;
  readonly connectInput = 'credentials' as const;
  private readonly fake = new FakeProvider();

  async connectWithCredentials(fields: Readonly<Record<string, string>>): Promise<AuthTokens> {
    asked += 1;
    return verdict(fields);
  }
  async generateAuthUrl(): Promise<GenerateAuthUrl> {
    throw new ProviderBadRequestError('connected with a pasted credential');
  }
  async authenticate(): Promise<AuthTokens> {
    throw new ProviderBadRequestError('connected with a pasted credential');
  }
  async refreshToken(): Promise<AuthTokens> {
    throw new ProviderAuthError('nothing to refresh');
  }
  post(tokens: AuthTokens, details: PostDetails[]): Promise<PostResult> {
    return this.fake.post(tokens, details);
  }
  async postAnalytics(): Promise<MetricPoint[]> {
    return [];
  }
  async accountAnalytics(): Promise<MetricPoint[]> {
    return [];
  }
}

const accept =
  (externalId = 'chan-1', displayName = 'Acme News') =>
  (fields: Readonly<Record<string, string>>): AuthTokens => ({
    accessToken: JSON.stringify({ v: 1, token: fields.token }),
    externalId,
    displayName,
  });

beforeAll(() => {
  useTestDatabaseEnv();
  process.env.TOKEN_ENCRYPTION_KEY ??= 'integration-test-key';
  // vitest isolates the registry per file, so replacing `fake` here touches nothing else.
  registerProvider(new PastedCredentialProvider());
});
beforeEach(async () => {
  await resetDb();
  resetAttemptStore();
  asked = 0;
  verdict = accept();
});
afterAll(closeDb);

async function rows(ws: string) {
  return withWorkspace(ws, (tx) => tx.select().from(schema.connections));
}

describe('connectWithCredentials', () => {
  it('stores the credential encrypted, as a one-time token with no expiry', async () => {
    const ws = await createWorkspace();
    const result = await connectWithCredentials(ws, 'fake', { token: SECRET }, IP);
    expect(result).toMatchObject({ ok: true, displayName: 'Acme News', reconnected: false });

    const [row] = await rows(ws);
    expect(row).toMatchObject({
      provider: 'fake',
      externalId: 'chan-1',
      displayName: 'Acme News',
      tokenModel: 'one-time',
      refreshToken: null,
      expiresAt: null,
      needsReconnect: false,
    });
    expect(row!.accessToken).not.toContain(SECRET);
    expect(decryptToken(row!.accessToken!)).toBe(JSON.stringify({ v: 1, token: SECRET }));
  });

  it('never returns the credential: not from the call, not from the connection list', async () => {
    const ws = await createWorkspace();
    const result = await connectWithCredentials(ws, 'fake', { token: SECRET }, IP);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(await listConnections(ws))).not.toContain(SECRET);
  });

  it('a second connect to the same account replaces the credential on the same connection', async () => {
    useRecordingScheduler();
    const ws = await createWorkspace();
    const first = await connectWithCredentials(ws, 'fake', { token: SECRET }, IP);
    if (!first.ok) throw new Error('expected a connection');
    await withWorkspace(ws, (tx) =>
      tx
        .update(schema.connections)
        .set({ needsReconnect: true })
        .where(eq(schema.connections.id, first.connectionId)),
    );
    const [scheduled] = await createPost(ws, {
      caption: 'still booked',
      media: [],
      variants: [{ connectionId: first.connectionId, provider: 'fake' }],
      schedule: { type: 'at', publishAt: new Date(Date.now() + 3_600_000) },
    });

    verdict = accept('chan-1', 'Acme News (renamed)');
    const second = await connectWithCredentials(ws, 'fake', { token: 'tok_live_ROTATED_42' }, IP);
    expect(second).toMatchObject({
      ok: true,
      connectionId: first.connectionId,
      reconnected: true,
      displayName: 'Acme News (renamed)',
    });
    const all = await rows(ws);
    expect(all).toHaveLength(1);
    expect(all[0]!.needsReconnect).toBe(false);
    expect(decryptToken(all[0]!.accessToken!)).toContain('tok_live_ROTATED_42');
    // The post booked on the connection is still on it.
    const [post] = await withWorkspace(ws, (tx) =>
      tx.select().from(schema.posts).where(eq(schema.posts.id, scheduled!.id)),
    );
    expect(post!.connectionId).toBe(first.connectionId);
  });

  it('a different account is a different connection', async () => {
    const ws = await createWorkspace();
    await connectWithCredentials(ws, 'fake', { token: SECRET }, IP);
    verdict = accept('chan-2', 'Acme Offers');
    await connectWithCredentials(ws, 'fake', { token: SECRET }, IP);
    expect((await rows(ws)).map((r) => r.externalId).sort()).toEqual(['chan-1', 'chan-2']);
  });

  it('keeps workspaces apart: the same account connected for two clients is two connections', async () => {
    const [a, b] = [await createWorkspace('A'), await createWorkspace('B')];
    const inA = await connectWithCredentials(a, 'fake', { token: SECRET }, IP);
    const inB = await connectWithCredentials(b, 'fake', { token: SECRET }, IP);
    if (!inA.ok || !inB.ok) throw new Error('expected connections');
    expect(inB.reconnected).toBe(false);
    expect(inB.connectionId).not.toBe(inA.connectionId);
    expect(await rows(a)).toHaveLength(1);
    expect(await rows(b)).toHaveLength(1);
  });

  it('stores nothing when the platform refuses the credential', async () => {
    const ws = await createWorkspace();
    verdict = () => {
      throw new ProviderAuthError('The platform did not accept the token.');
    };
    await expect(connectWithCredentials(ws, 'fake', { token: SECRET }, IP)).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
    expect(await rows(ws)).toHaveLength(0);
  });

  it('refuses a provider that does not connect this way', async () => {
    const ws = await createWorkspace();
    registerProvider(new FakeProvider());
    try {
      await expect(
        connectWithCredentials(ws, 'fake', { token: SECRET }, IP),
      ).rejects.toBeInstanceOf(ProviderBadRequestError);
    } finally {
      registerProvider(new PastedCredentialProvider());
    }
  });
});

describe('connectWithCredentials — attempt limit', () => {
  const { perAccount, perIp } = AUTH_ATTEMPT_LIMITS.connect;
  const refuse = () => {
    verdict = () => {
      throw new ProviderAuthError('The platform did not accept the token.');
    };
  };
  const fail = (ws: string, ip = IP) =>
    connectWithCredentials(ws, 'fake', { token: 'guess' }, ip).catch((e: unknown) => e);

  it('stops presenting tokens to the platform once a workspace has used its guesses', async () => {
    const ws = await createWorkspace();
    refuse();
    // Different addresses each time: the per-workspace limit is what is under test.
    for (let i = 0; i < perAccount; i++) await fail(ws, `198.51.100.${i}`);
    expect(asked).toBe(perAccount);
    const blocked = await connectWithCredentials(ws, 'fake', { token: 'guess' }, '198.51.100.250');
    expect(blocked).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect((blocked as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    // Not even a correct credential gets through while blocked — and the platform is not asked.
    verdict = accept();
    expect(
      await connectWithCredentials(ws, 'fake', { token: SECRET }, '198.51.100.251'),
    ).toMatchObject({
      ok: false,
    });
    expect(asked).toBe(perAccount);
  });

  it('stops one address guessing across many workspaces', async () => {
    refuse();
    for (let i = 0; i < perIp; i++) await fail(await createWorkspace(`W${i}`));
    const blocked = await connectWithCredentials(await createWorkspace('last'), 'fake', {}, IP);
    expect(blocked).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(asked).toBe(perIp);
  });

  it('does not count a typo caught before the platform, or a platform that is down', async () => {
    const ws = await createWorkspace();
    for (const error of [
      new CredentialFormatError('That is not a token.'),
      new ProviderTransientError('The platform could not be reached.'),
    ]) {
      verdict = () => {
        throw error;
      };
      for (let i = 0; i < perAccount + 2; i++) expect(await fail(ws)).toBe(error);
    }
    verdict = accept();
    expect(await connectWithCredentials(ws, 'fake', { token: SECRET }, IP)).toMatchObject({
      ok: true,
    });
  });

  it('counts a platform refusal that is not about shape (wrong channel, missing rights)', async () => {
    const ws = await createWorkspace();
    verdict = () => {
      throw new ProviderBadRequestError('The bot is not an administrator of that channel.');
    };
    for (let i = 0; i < perAccount; i++) await fail(ws, `198.51.100.${i}`);
    expect(await connectWithCredentials(ws, 'fake', {}, '198.51.100.250')).toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
  });

  it('a success clears the workspace’s count', async () => {
    const ws = await createWorkspace();
    refuse();
    for (let i = 0; i < perAccount - 1; i++) await fail(ws, `198.51.100.${i}`);
    verdict = accept();
    expect(await connectWithCredentials(ws, 'fake', { token: SECRET }, IP)).toMatchObject({
      ok: true,
    });
    refuse();
    for (let i = 0; i < perAccount; i++) {
      expect(await fail(ws, `198.51.100.${100 + i}`)).toBeInstanceOf(ProviderAuthError);
    }
  });
});
