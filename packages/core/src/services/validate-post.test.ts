import { afterEach, describe, expect, it } from 'vitest';
import { createPostInput } from '@meegrow-social/contracts';
import { ProviderBadRequestError } from '../errors.js';
import { registerProvider } from '../providers/registry.js';
import type { PostDetails, SocialProvider } from '../providers/types.js';
import { contractIssues, publishabilityIssues } from './validate-post.js';

/**
 * The DB-free half of the dry run: how contract failures and provider rules become issues. The
 * checks that need Postgres (connection ownership, queue, media) are in
 * `validate-post.integration.test.ts`.
 */
const CONN_A = '11111111-1111-4111-8111-111111111111';
const CONN_B = '22222222-2222-4222-8222-222222222222';

function issuesFor(raw: unknown) {
  const parsed = createPostInput.safeParse(raw);
  if (parsed.success) throw new Error('fixture was expected to fail the contract');
  return contractIssues(raw, parsed.error);
}

describe('contractIssues', () => {
  it('reports a body-level failure with no target', () => {
    expect(issuesFor({ caption: 'x' })).toEqual([
      { code: 'invalid_request', message: 'variants: Required' },
    ]);
  });

  it('tags a failure inside a variant with that variant, and only that one', () => {
    const issues = issuesFor({
      variants: [
        { connectionId: CONN_A, provider: 'fake' },
        { connectionId: CONN_B, provider: 'youtube' }, // youtube needs options
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'invalid_request',
      connectionId: CONN_B,
      provider: 'youtube',
    });
    expect(issues[0]!.message).toMatch(/^variants\.1\.options: /);
  });

  it('never echoes a provider that is not a real identifier', () => {
    const [issue] = issuesFor({ variants: [{ connectionId: CONN_A, provider: 'myspace' }] });
    expect(issue).toMatchObject({ code: 'invalid_request', connectionId: CONN_A });
    expect(issue).not.toHaveProperty('provider');
  });

  it('reports every failure, not just the first', () => {
    const issues = issuesFor({
      caption: 'x'.repeat(5001),
      variants: [{ connectionId: 'not-a-uuid', provider: 'fake' }],
    });
    expect(issues.map((i) => i.message.split(':')[0])).toEqual([
      'caption',
      'variants.0.connectionId',
    ]);
  });

  it.each([undefined, null, 'a string', 42, []])('survives a non-object body: %j', (raw) => {
    const issues = issuesFor(raw);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue.code).toBe('invalid_request');
  });
});

describe('publishabilityIssues', () => {
  /** What the stub's `assertPublishable` was handed, per call. */
  const seen: PostDetails[] = [];
  const stub = (reject: (d: PostDetails) => string | null): SocialProvider =>
    ({
      identifier: 'x',
      assertPublishable(details: PostDetails[]) {
        seen.push(...details);
        const reason = reject(details[0]!);
        if (reason) throw new ProviderBadRequestError(reason);
      },
    }) as unknown as SocialProvider;

  // Each test registers its own `x` (unregistered by default, and vitest isolates the registry
  // per file), so nothing needs restoring.
  afterEach(() => {
    seen.length = 0;
  });

  const input = (variants: unknown[]) => createPostInput.parse({ caption: 'group', variants });

  it('is empty when no provider objects — including providers with no rules at all', () => {
    registerProvider(stub(() => null));
    const issues = publishabilityIssues(
      input([
        { connectionId: CONN_A, provider: 'x' },
        { connectionId: CONN_B, provider: 'fake' },
      ]),
    );
    expect(issues).toEqual([]);
  });

  it('collects one issue per rejected variant instead of stopping at the first', () => {
    registerProvider(stub((d) => (d.caption.length > 5 ? `too long: ${d.caption}` : null)));
    const issues = publishabilityIssues(
      input([
        { connectionId: CONN_A, provider: 'x', caption: 'first one' },
        { connectionId: CONN_B, provider: 'x', caption: 'ok' },
        { connectionId: CONN_A, provider: 'x' }, // inherits the group caption, "group" = 5 chars
        { connectionId: CONN_B, provider: 'x', caption: 'second one' },
      ]),
    );
    expect(issues).toEqual([
      {
        connectionId: CONN_A,
        provider: 'x',
        code: 'not_publishable',
        message: 'too long: first one',
      },
      {
        connectionId: CONN_B,
        provider: 'x',
        code: 'not_publishable',
        message: 'too long: second one',
      },
    ]);
  });

  it('hands the provider what create hands it: the variant override, else the group value', () => {
    registerProvider(stub(() => null));
    publishabilityIssues(
      input([
        { connectionId: CONN_A, provider: 'x' },
        { connectionId: CONN_B, provider: 'x', caption: 'override' },
      ]),
    );
    expect(seen.map((d) => d.caption)).toEqual(['group', 'override']);
  });

  it('does not swallow an error that is not a provider rule', () => {
    registerProvider({
      identifier: 'x',
      assertPublishable() {
        throw new TypeError('provider bug');
      },
    } as unknown as SocialProvider);
    expect(() => publishabilityIssues(input([{ connectionId: CONN_A, provider: 'x' }]))).toThrow(
      TypeError,
    );
  });
});
