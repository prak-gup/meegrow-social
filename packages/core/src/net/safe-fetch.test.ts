import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeUrl,
  blockedAddressReason,
  nodeTransport,
  parseIpv4,
  parseIpv6,
  pinnedLookup,
  safeFetch,
  SafeFetchError,
  SsrfBlockedError,
  type PinnedRequest,
  type RawResponse,
  type Resolver,
  type Transport,
} from './safe-fetch.js';

/**
 * The SSRF guard. Nothing here touches a network other than loopback: name resolution and the
 * transport are injected, and the one real-socket block talks to a listener this file starts on
 * 127.0.0.1 through `nodeTransport(http.request)` — the transport itself never validates, which is
 * exactly what lets it be pointed at loopback to prove the pin.
 */

const PUBLIC_V4 = '93.184.216.34';

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SsrfBlockedError) return err.reason;
    throw err;
  }
  return 'allowed';
}

describe('blockedAddressReason — IPv4', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.127.255.255', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.0.1', 'link-local'],
    ['169.254.169.254', 'metadata'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.1', 'IETF'],
    ['192.0.2.10', 'documentation'],
    ['192.88.99.1', '6to4'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.7', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ])('blocks %s (%s)', (address, why) => {
    expect(blockedAddressReason(address)).toContain(why);
  });

  it.each([
    PUBLIC_V4,
    '8.8.8.8',
    '1.1.1.1',
    '9.255.255.255', // just below 10/8
    '11.0.0.0', // just above 10/8
    '100.63.255.255', // just below CGNAT
    '100.128.0.0', // just above CGNAT
    '172.15.255.255',
    '172.32.0.0',
    '169.253.255.255',
    '169.255.0.0',
    '192.167.255.255',
    '192.169.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255', // last unicast address
  ])('allows the public address %s', (address) => {
    expect(blockedAddressReason(address)).toBeNull();
  });
});

describe('blockedAddressReason — IPv6', () => {
  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['fc00::1', 'global unicast'], // unique-local
    ['fd00:ec2::254', 'global unicast'], // AWS IPv6 metadata lives in unique-local space
    ['fdff:ffff::1', 'global unicast'],
    ['fe80::1', 'global unicast'], // link-local
    ['febf::1', 'global unicast'],
    ['fec0::1', 'global unicast'], // site-local (deprecated)
    ['ff02::1', 'global unicast'], // multicast
    ['100::1', 'global unicast'], // discard prefix
    ['2001:db8::1', 'documentation'],
    ['2001::1', 'Teredo'],
    ['64:ff9b:1::1', 'NAT64 local-use'],
    ['::127.0.0.1', 'IPv4-compatible'],
    ['::0.0.0.2', 'IPv4-compatible'],
  ])('blocks %s (%s)', (address, why) => {
    expect(blockedAddressReason(address)).toContain(why);
  });

  it.each([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'], // the same address as the URL parser writes it
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['::ffff:192.168.0.1', 'private'],
    ['::ffff:100.64.0.1', 'carrier-grade NAT'],
    ['0:0:0:0:0:ffff:7f00:1', 'loopback'],
  ])('judges the IPv4-mapped %s by its IPv4 address (%s)', (address, why) => {
    expect(blockedAddressReason(address)).toContain(why);
  });

  it.each([
    ['64:ff9b::7f00:1', 'loopback'], // NAT64 of 127.0.0.1
    ['64:ff9b::a00:1', 'private'], // NAT64 of 10.0.0.1
    ['2002:7f00:1::1', 'loopback'], // 6to4 of 127.0.0.1
    ['2002:c0a8:101::1', 'private'], // 6to4 of 192.168.1.1
    ['2002:a9fe:a9fe::1', 'metadata'], // 6to4 of 169.254.169.254
  ])('judges the embedded IPv4 of %s (%s)', (address, why) => {
    expect(blockedAddressReason(address)).toContain(why);
  });

  it.each([
    '2606:4700:4700::1111',
    '2a00:1450:4001:81b::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808', // NAT64 of 8.8.8.8
    '2002:808:808::1', // 6to4 of 8.8.8.8
    '[2606:4700:4700::1111]',
  ])('allows the public address %s', (address) => {
    expect(blockedAddressReason(address)).toBeNull();
  });

  it('refuses a zone id, and anything it cannot read', () => {
    expect(blockedAddressReason('fe80::1%eth0')).toBe('unreadable address');
    expect(blockedAddressReason('not-an-address')).toBe('unreadable address');
    expect(blockedAddressReason('1.2.3')).toBe('unreadable address');
    expect(blockedAddressReason('')).toBe('unreadable address');
  });
});

describe('address parsers', () => {
  it('parseIpv4 takes strict dotted decimal only', () => {
    expect(parseIpv4('127.0.0.1')).toBe(0x7f000001);
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffff);
    for (const bad of ['127.1', '0x7f.0.0.1', '0177.0.0.1', '256.0.0.1', '1.2.3.4.5', '1.2.3.']) {
      expect(parseIpv4(bad)).toBeNull();
    }
  });

  it('parseIpv6 expands :: and a dotted tail', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('2001:db8::8:800:200c:417a')).toEqual([
      0x2001, 0xdb8, 0, 0, 8, 0x800, 0x200c, 0x417a,
    ]);
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6('1:2:3:4:5:6:1.2.3.4')).toEqual([1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
    for (const bad of ['1::2::3', '1:2:3', '12345::', 'g::1', '1:2:3:4:5:6:7:8:9', '::1%lo0']) {
      expect(parseIpv6(bad)).toBeNull();
    }
  });
});

describe('assertSafeUrl', () => {
  it('accepts a plain public https address', () => {
    expect(assertSafeUrl('https://example.com/blog').hostname).toBe('example.com');
    expect(assertSafeUrl('https://example.com:443/').port).toBe('');
    expect(assertSafeUrl(`https://${PUBLIC_V4}/`).hostname).toBe(PUBLIC_V4);
    expect(assertSafeUrl('https://[2606:4700:4700::1111]/').hostname).toBe(
      '[2606:4700:4700::1111]',
    );
  });

  it.each([
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
    ['example.com', 'invalid_url'],
    ['http://example.com', 'scheme'],
    ['ftp://example.com', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['gopher://example.com', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['https://user:pass@example.com', 'credentials'],
    ['https://user@example.com', 'credentials'],
    ['https://example.com:8443', 'port'],
    ['https://example.com:22', 'port'],
    ['https://example.com:80', 'port'],
  ])('refuses %s (%s)', (url, why) => {
    expect(reason(() => assertSafeUrl(url))).toBe(why);
  });

  it.each([
    'https://localhost',
    'https://LOCALHOST',
    'https://localhost.',
    'https://app.localhost',
    'https://printer.local',
    'https://db.internal',
    'https://metadata.google.internal',
    'https://wiki.corp',
    'https://router.lan',
    'https://nas.home',
    'https://box.home.arpa',
    'https://portal.intranet',
    'https://intranet', // single label: only a search-domain could resolve it
  ])('refuses the internal name %s', (url) => {
    expect(reason(() => assertSafeUrl(url))).toBe('hostname');
  });

  // The WHATWG parser folds every one of these into dotted decimal before the range check runs.
  it.each([
    ['https://127.0.0.1', 'dotted loopback'],
    ['https://2130706433', 'decimal 127.0.0.1'],
    ['https://0x7f000001', 'hex 127.0.0.1'],
    ['https://0x7f.0.0.1', 'hex octet'],
    ['https://017700000001', 'octal 127.0.0.1'],
    ['https://0177.0.0.1', 'octal octet'],
    ['https://127.1', 'short form'],
    ['https://127.0.1', 'short form'],
    ['https://0', 'zero'],
    ['https://0.0.0.0', 'unspecified'],
    ['https://3232235777', 'decimal 192.168.1.1'],
    ['https://0xc0a80101', 'hex 192.168.1.1'],
    ['https://0300.0250.01.01', 'octal 192.168.1.1'],
    ['https://2852039166', 'decimal 169.254.169.254'],
    ['https://0xa9fea9fe', 'hex 169.254.169.254'],
    ['https://169.254.169.254', 'metadata'],
    ['https://10.0.0.5', 'private'],
    ['https://172.20.0.1', 'private'],
    ['https://100.64.0.1', 'CGNAT'],
    ['https://224.0.0.1', 'multicast'],
    ['https://[::1]', 'IPv6 loopback'],
    ['https://[::]', 'IPv6 unspecified'],
    ['https://[::ffff:127.0.0.1]', 'IPv4-mapped loopback'],
    ['https://[::ffff:7f00:1]', 'IPv4-mapped loopback, hex'],
    ['https://[::ffff:169.254.169.254]', 'IPv4-mapped metadata'],
    ['https://[0:0:0:0:0:ffff:a00:1]', 'IPv4-mapped private, expanded'],
    ['https://[fd00:ec2::254]', 'unique-local'],
    ['https://[fe80::1]', 'link-local'],
    ['https://[ff02::1]', 'multicast'],
    ['https://[64:ff9b::7f00:1]', 'NAT64 loopback'],
    ['https://[2002:a00:1::1]', '6to4 private'],
  ])('refuses the address %s (%s)', (url) => {
    expect(reason(() => assertSafeUrl(url))).toBe('address');
  });

  it('never repeats the address back in the message', () => {
    try {
      assertSafeUrl('https://169.254.169.254/latest/meta-data');
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as Error).message).not.toContain('169.254');
    }
  });

  it('allows another port only when the caller names it', () => {
    expect(assertSafeUrl('https://example.com:8443', { allowedPorts: [443, 8443] }).port).toBe(
      '8443',
    );
  });
});

interface Sent {
  url: string;
  address: string;
  method: string;
  headers: Record<string, string>;
}

/** A transport that answers from a script, recording where each request was pinned. */
function scripted(responses: Array<Partial<RawResponse>>): { transport: Transport; sent: Sent[] } {
  const sent: Sent[] = [];
  let i = 0;
  const transport: Transport = async (request: PinnedRequest) => {
    sent.push({
      url: request.url.toString(),
      address: request.address,
      method: request.method,
      headers: request.headers,
    });
    const next = responses[i++];
    if (!next) throw new Error(`unexpected request to ${request.url.toString()}`);
    return { status: 200, headers: {}, body: Buffer.alloc(0), ...next };
  };
  return { transport, sent };
}

const resolver =
  (table: Record<string, string[]>): Resolver =>
  async (hostname) =>
    (table[hostname] ?? []).map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));

const publicDns = resolver({ 'example.com': [PUBLIC_V4], 'www.example.com': ['93.184.216.35'] });

describe('safeFetch', () => {
  it('pins the request to the address it validated', async () => {
    const { transport, sent } = scripted([{ body: Buffer.from('ok') }]);
    const res = await safeFetch(
      'https://example.com/wp-json/',
      {},
      { resolve: publicDns, transport },
    );
    expect(res.body.toString()).toBe('ok');
    expect(res.url).toBe('https://example.com/wp-json/');
    expect(sent).toEqual([
      { url: 'https://example.com/wp-json/', address: PUBLIC_V4, method: 'GET', headers: {} },
    ]);
  });

  it('refuses before any request when the name resolves to a private address', async () => {
    const { transport, sent } = scripted([]);
    const resolve = resolver({ 'evil.example.com': ['10.0.0.5'] });
    await expect(
      safeFetch('https://evil.example.com/', {}, { resolve, transport }),
    ).rejects.toMatchObject({ reason: 'address' });
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['127.0.0.1'],
    ['169.254.169.254'],
    ['192.168.1.10'],
    ['100.64.1.1'],
    ['::1'],
    ['fd00::1'],
    ['::ffff:10.0.0.1'],
  ])('refuses a name that resolves to %s', async (address) => {
    const { transport, sent } = scripted([]);
    const resolve = resolver({ 'evil.example.com': [address] });
    await expect(
      safeFetch('https://evil.example.com/', {}, { resolve, transport }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(sent).toHaveLength(0);
  });

  it('refuses when ANY of several addresses is private', async () => {
    const { transport, sent } = scripted([]);
    const resolve = resolver({ 'mixed.example.com': [PUBLIC_V4, '10.0.0.5'] });
    await expect(
      safeFetch('https://mixed.example.com/', {}, { resolve, transport }),
    ).rejects.toMatchObject({ reason: 'address' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a name that does not resolve, without leaking the resolver error', async () => {
    const { transport } = scripted([]);
    const resolve: Resolver = async () => {
      throw new Error('getaddrinfo ENOTFOUND nope.example.com 10.1.2.3');
    };
    const err = await safeFetch('https://nope.example.com/', {}, { resolve, transport }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect((err as SsrfBlockedError).reason).toBe('dns');
    expect((err as Error).message).not.toContain('10.1.2.3');
    await expect(
      safeFetch('https://empty.example.com/', {}, { resolve: resolver({}), transport }),
    ).rejects.toMatchObject({ reason: 'dns' });
  });

  it('resolves once per request and uses that answer — a rebinding second answer is never asked for', async () => {
    let lookups = 0;
    const resolve: Resolver = async () => {
      lookups += 1;
      // First answer public, every later one private: the classic rebinding swap.
      return [{ address: lookups === 1 ? PUBLIC_V4 : '127.0.0.1', family: 4 }];
    };
    const { transport, sent } = scripted([{}]);
    await safeFetch('https://rebind.example.com/', {}, { resolve, transport });
    expect(lookups).toBe(1);
    expect(sent[0]!.address).toBe(PUBLIC_V4);
  });

  it('does not resolve an IP literal, and connects to exactly it', async () => {
    const { transport, sent } = scripted([{}]);
    const resolve: Resolver = async () => {
      throw new Error('must not be called');
    };
    await safeFetch(`https://${PUBLIC_V4}/`, {}, { resolve, transport });
    expect(sent[0]!.address).toBe(PUBLIC_V4);
  });

  describe('redirects', () => {
    it('returns a 3xx untouched by default', async () => {
      const { transport, sent } = scripted([
        { status: 301, headers: { location: 'https://www.example.com/' } },
      ]);
      const res = await safeFetch('https://example.com/', {}, { resolve: publicDns, transport });
      expect(res.status).toBe(301);
      expect(sent).toHaveLength(1);
    });

    it('follows up to maxRedirects, re-resolving and re-pinning every hop', async () => {
      const { transport, sent } = scripted([
        { status: 301, headers: { location: 'https://www.example.com/' } },
        { status: 200, body: Buffer.from('home') },
      ]);
      const res = await safeFetch(
        'https://example.com/',
        { maxRedirects: 3 },
        { resolve: publicDns, transport },
      );
      expect(res.url).toBe('https://www.example.com/');
      expect(sent.map((s) => s.address)).toEqual([PUBLIC_V4, '93.184.216.35']);
    });

    it('resolves a relative Location against the current URL', async () => {
      const { transport, sent } = scripted([
        { status: 302, headers: { location: '/blog/' } },
        { status: 200 },
      ]);
      await safeFetch(
        'https://example.com/a',
        { maxRedirects: 1 },
        { resolve: publicDns, transport },
      );
      expect(sent[1]!.url).toBe('https://example.com/blog/');
    });

    it.each([
      ['http://example.com/', 'scheme'],
      ['https://127.0.0.1/', 'address'],
      ['https://169.254.169.254/latest/meta-data/', 'address'],
      ['https://[::1]/', 'address'],
      ['https://2130706433/', 'address'],
      ['https://localhost/', 'hostname'],
      ['https://user:pw@example.com/', 'credentials'],
      ['https://example.com:8080/', 'port'],
      ['file:///etc/passwd', 'scheme'],
    ])('refuses a redirect to %s', async (location, why) => {
      const { transport, sent } = scripted([{ status: 302, headers: { location } }]);
      await expect(
        safeFetch('https://example.com/', { maxRedirects: 3 }, { resolve: publicDns, transport }),
      ).rejects.toMatchObject({ reason: why });
      expect(sent).toHaveLength(1);
    });

    it('refuses a redirect to a public name that resolves privately', async () => {
      const { transport, sent } = scripted([
        { status: 302, headers: { location: 'https://inner.example.com/' } },
      ]);
      const resolve = resolver({ 'example.com': [PUBLIC_V4], 'inner.example.com': ['10.0.0.9'] });
      await expect(
        safeFetch('https://example.com/', { maxRedirects: 3 }, { resolve, transport }),
      ).rejects.toMatchObject({ reason: 'address' });
      expect(sent).toHaveLength(1);
    });

    it('stops at the cap', async () => {
      const hop = { status: 302, headers: { location: 'https://example.com/again' } };
      const { transport, sent } = scripted([hop, hop, hop]);
      await expect(
        safeFetch('https://example.com/', { maxRedirects: 2 }, { resolve: publicDns, transport }),
      ).rejects.toMatchObject({ kind: 'too_many_redirects' });
      expect(sent).toHaveLength(3);
    });

    it('never replays a request with a body', async () => {
      const { transport, sent } = scripted([
        { status: 307, headers: { location: 'https://www.example.com/' } },
      ]);
      await expect(
        safeFetch(
          'https://example.com/',
          { method: 'POST', body: '{}', maxRedirects: 3 },
          { resolve: publicDns, transport },
        ),
      ).rejects.toMatchObject({ kind: 'bad_redirect' });
      expect(sent).toHaveLength(1);
    });

    it('drops Authorization when a redirect leaves the origin, keeps it within', async () => {
      const { transport, sent } = scripted([
        { status: 302, headers: { location: 'https://example.com/b' } },
        { status: 302, headers: { location: 'https://www.example.com/c' } },
        { status: 200 },
      ]);
      await safeFetch(
        'https://example.com/a',
        {
          maxRedirects: 3,
          headers: { Authorization: 'Basic c2VjcmV0', Accept: 'application/json' },
        },
        { resolve: publicDns, transport },
      );
      expect(sent[0]!.headers.authorization).toBe('Basic c2VjcmV0');
      expect(sent[1]!.headers.authorization).toBe('Basic c2VjcmV0');
      expect(sent[2]!.headers.authorization).toBeUndefined();
      expect(sent[2]!.headers.accept).toBe('application/json');
    });
  });

  it('hands the byte cap and a shrinking deadline to the transport', async () => {
    const seen: Array<{ timeoutMs: number; maxResponseBytes: number }> = [];
    const transport: Transport = async (request) => {
      seen.push({ timeoutMs: request.timeoutMs, maxResponseBytes: request.maxResponseBytes });
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    };
    await safeFetch(
      'https://example.com/',
      { timeoutMs: 4000, maxResponseBytes: 1234 },
      { resolve: publicDns, transport },
    );
    expect(seen[0]!.maxResponseBytes).toBe(1234);
    expect(seen[0]!.timeoutMs).toBeGreaterThan(0);
    expect(seen[0]!.timeoutMs).toBeLessThanOrEqual(4000);
  });

  it('times out a name lookup that never answers', async () => {
    const { transport } = scripted([]);
    const resolve: Resolver = () => new Promise(() => undefined);
    await expect(
      safeFetch('https://slow.example.com/', { timeoutMs: 30 }, { resolve, transport }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('spends one deadline across redirects', async () => {
    let calls = 0;
    const transport: Transport = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 40));
      return {
        status: 302,
        headers: { location: 'https://example.com/next' },
        body: Buffer.alloc(0),
      };
    };
    await expect(
      safeFetch(
        'https://example.com/',
        { timeoutMs: 60, maxRedirects: 10 },
        { resolve: publicDns, transport },
      ),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(calls).toBeLessThan(4);
  });
});

describe('pinnedLookup', () => {
  it('answers with the pinned address in both of node’s calling conventions', () => {
    const lookup = pinnedLookup(PUBLIC_V4, 4);
    const single: unknown[] = [];
    lookup('anything.example.com', {}, (...args) => single.push(...args));
    expect(single).toEqual([null, PUBLIC_V4, 4]);

    const all: unknown[] = [];
    lookup('anything.example.com', { all: true }, (...args) => all.push(...args));
    expect(all).toEqual([null, [{ address: PUBLIC_V4, family: 4 }]]);

    const bare: unknown[] = [];
    (lookup as unknown as (h: string, cb: (...a: unknown[]) => void) => void)('x', (...args) =>
      bare.push(...args),
    );
    expect(bare).toEqual([null, PUBLIC_V4, 4]);
  });
});

/**
 * The real transport over a real socket — plain http to a listener on loopback, which is reachable
 * only because this block calls the transport directly (safeFetch would refuse the address).
 */
describe('nodeTransport', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function listen(handler: http.RequestListener): Promise<number> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  const request = (port: number, over: Partial<PinnedRequest> = {}): PinnedRequest => ({
    // A name that resolves nowhere: the request can only arrive if the pin is what connects.
    url: new URL(`http://pinned.invalid:${port}/wp-json/?x=1`),
    address: '127.0.0.1',
    family: 4,
    method: 'GET',
    headers: {},
    timeoutMs: 2000,
    maxResponseBytes: 1024,
    ...over,
  });

  const transport = nodeTransport(http.request);

  it('connects to the pinned address and keeps the real Host header', async () => {
    let seenHost = '';
    let seenPath = '';
    const port = await listen((req, res) => {
      seenHost = req.headers.host ?? '';
      seenPath = req.url ?? '';
      res.setHeader('x-test', 'yes');
      res.end('hello');
    });
    const res = await transport(request(port));
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('hello');
    expect(res.headers['x-test']).toBe('yes');
    expect(seenHost).toBe(`pinned.invalid:${port}`);
    expect(seenPath).toBe('/wp-json/?x=1');
  });

  it('sends a body with its length', async () => {
    let received = '';
    let length = '';
    const port = await listen((req, res) => {
      length = req.headers['content-length'] ?? '';
      req.on('data', (c: Buffer) => (received += c.toString()));
      req.on('end', () => res.end('done'));
    });
    await transport(request(port, { method: 'POST', body: Buffer.from('{"a":1}') }));
    expect(received).toBe('{"a":1}');
    expect(length).toBe('7');
  });

  it('does not follow a redirect itself', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/' });
      res.end();
    });
    const res = await transport(request(port));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://127.0.0.1:1/');
  });

  it('aborts a response that declares more than the cap', async () => {
    const port = await listen((_req, res) => {
      res.setHeader('content-length', '5000');
      res.end(Buffer.alloc(5000, 'a'));
    });
    await expect(transport(request(port))).rejects.toMatchObject({ kind: 'too_large' });
  });

  it('aborts a response that streams past the cap without declaring a length', async () => {
    const port = await listen((_req, res) => {
      res.write(Buffer.alloc(800, 'a'));
      res.write(Buffer.alloc(800, 'a'));
      res.end();
    });
    await expect(transport(request(port))).rejects.toMatchObject({ kind: 'too_large' });
  });

  it('gives up at the deadline, and says the request had been sent', async () => {
    const port = await listen(() => {
      // Never answers.
    });
    const err = await transport(request(port, { timeoutMs: 80 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect(err).toMatchObject({ kind: 'timeout', requestSent: true });
  });

  it('reports a refused connection as a network failure that was never sent', async () => {
    const port = await listen((_req, res) => res.end());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const err = await transport(request(port)).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'network', requestSent: false });
  });
});
