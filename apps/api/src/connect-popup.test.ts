import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectOutcome, connectPopupHtml } from './server.js';

/**
 * The OAuth popup page (#45). Page/account names in the payload come from the *provider* (Meta
 * returns whatever the Page is called), so this page embeds attacker-influenceable text inside a
 * <script> tag. These tests lock the two properties that keep that safe: no </script> breakout, and
 * the result is posted to our own origin rather than broadcast.
 */

const ORIGINAL_APP_URL = process.env.APP_URL;

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL;
});

describe('connectPopupHtml', () => {
  it('hands the payload to the opener and closes', () => {
    process.env.APP_URL = 'https://social.meegrowlabs.com';
    const html = connectPopupHtml({ status: 'connected', connectionId: 'abc' });

    expect(html).toContain('window.opener.postMessage');
    expect(html).toContain("source: 'meegrow-social-connect'");
    expect(html).toContain('window.close()');
    expect(html).toContain('"connected"');
  });

  it('posts to our own origin, never "*"', () => {
    process.env.APP_URL = 'https://social.meegrowlabs.com';
    const html = connectPopupHtml({ status: 'connected', connectionId: 'abc' });

    expect(html).toContain('"https://social.meegrowlabs.com"');
    // A wildcard target would let any page that opened us read the connection result.
    expect(html).not.toContain(", '*'");
    expect(html).not.toContain(', "*"');
  });

  it('strips a trailing slash off APP_URL so the origin matches exactly', () => {
    process.env.APP_URL = 'https://social.meegrowlabs.com/';
    expect(connectPopupHtml({ status: 'connected', connectionId: 'a' })).toContain(
      '"https://social.meegrowlabs.com"',
    );
  });

  it('escapes < so a provider-supplied name cannot break out of the script tag', () => {
    process.env.APP_URL = 'https://social.meegrowlabs.com';
    const html = connectPopupHtml({
      status: 'choose_account',
      flowId: 'f1',
      accounts: [
        { externalId: '1', displayName: '</script><img src=x onerror=alert(1)>' },
        { externalId: '2', displayName: 'Perfectly Normal Page' },
      ],
    });

    // The payload's closing tag must not survive as real markup...
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script');
    // ...and the page must still carry exactly one real </script>, its own.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('Perfectly Normal Page');
  });

  it('escapes provider-supplied text in the visible page too', () => {
    const html = connectPopupHtml({ status: 'error', error: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

/**
 * Runs the page's own script against a stub window, so what is asserted is what a browser does —
 * with a dashboard behind the popup, and without one (an invite, or a top-level redirect).
 */
function open(payload: unknown, withOpener: boolean) {
  const html = connectPopupHtml(payload);
  const text = (id: string): string =>
    (html.match(new RegExp(`<[a-z0-9]+ id="${id}">([^<]*)<`)) ?? [])[1] ?? '';
  const shown = { t: text('t'), m: text('m') };
  const posted: Array<{ message: unknown; target: unknown }> = [];
  let closed = false;
  const window = {
    opener: withOpener
      ? { postMessage: (message: unknown, target: unknown) => posted.push({ message, target }) }
      : null,
    close: () => {
      closed = true;
    },
  };
  const document = {
    querySelectorAll: () => [],
    getElementById: (id: 't' | 'm') => ({
      onclick: null,
      set textContent(value: string) {
        shown[id] = value;
      },
    }),
  };
  const script = html.slice(
    html.indexOf('<script>') + '<script>'.length,
    html.indexOf('</script>'),
  );
  const signals: unknown[] = [];
  class Channel {
    postMessage(signal: unknown) {
      signals.push(signal);
    }
    close() {}
  }
  new Function('window', 'document', 'BroadcastChannel', script)(window, document, Channel);
  return { title: shown.t, detail: shown.m, posted, closed, signals };
}

const FLOW = '0b6f1c1e-6f0a-4e0e-9a51-0d6c6f2f8a11';
const PAYLOADS = {
  connected: { status: 'connected', connectionId: 'abc' },
  choose_account: {
    status: 'choose_account',
    flowId: FLOW,
    accounts: [{ externalId: '1', displayName: 'Page One' }],
  },
  no_accounts: { status: 'choose_account', flowId: FLOW, accounts: [] },
  error: { status: 'error', error: 'connect flow expired' },
} as const;

describe('callback page with an opener (the dashboard popup)', () => {
  beforeEach(() => {
    process.env.APP_URL = 'https://social.meegrowlabs.com';
  });

  it.each(Object.entries(PAYLOADS))('%s: hands the payload over and closes', (_name, payload) => {
    const page = open(payload, true);
    expect(page.posted).toEqual([
      {
        message: { source: 'meegrow-social-connect', payload },
        target: 'https://social.meegrowlabs.com',
      },
    ]);
    expect(page.closed).toBe(true);
    // If the browser refuses to close it, the leftover text must not claim an outcome.
    expect(page.title).toBe(connectOutcome(payload).title);
  });
});

describe('callback page without an opener', () => {
  it.each(Object.entries(PAYLOADS))('%s: posts nothing and stays open', (_name, payload) => {
    const page = open(payload, false);
    expect(page.posted).toEqual([]);
    expect(page.closed).toBe(false);
  });

  it('says Connected only when a connection was created', () => {
    const page = open(PAYLOADS.connected, false);
    expect(page.title).toBe('Connected — you can close this tab');
    expect(page.detail).toContain('The account is connected');
  });

  it('does not call an unfinished account pick a success', () => {
    const page = open(PAYLOADS.choose_account, false);
    expect(page.title).toBe('Choose the account to connect');
    expect(page.detail).toContain('Choose an account');
  });

  it('explains an empty account list instead of a picker or a success', () => {
    const page = open(PAYLOADS.no_accounts, false);
    expect(page.title).toBe('Nothing to connect');
    expect(page.detail).toContain('did not offer any account');
    expect(page.detail).toContain('Nothing has been connected');
  });

  it('gives the reason for a failure', () => {
    const page = open(PAYLOADS.error, false);
    expect(page.title).toBe('Not connected');
    expect(page.detail).toContain('Connecting failed: connect flow expired.');
    expect(page.detail).toContain('Nothing has been connected');
  });

  it('is already truthful before any script runs', () => {
    // The outcome is rendered server-side; the script only ever handles the opener case.
    const html = connectPopupHtml(PAYLOADS.choose_account);
    expect(html).toContain('<h1 id="t">Not connected yet</h1>');
    expect(html).not.toContain('Connected. You can close this window.');
  });
});

describe('callback page look', () => {
  it.each(Object.entries(PAYLOADS))('%s: wears the invite card and mark', (_name, payload) => {
    const html = connectPopupHtml(payload);
    // An invited client can land here; it must not be bare text on a white page.
    expect(html).toContain('<div class="logo">');
    expect(html).toContain('meegrow<span>·social</span>');
    expect(html).toContain('<main>');
    expect(html).toContain('name="viewport"');
  });
});

describe('connectOutcome', () => {
  it('reports connected for exactly one status', () => {
    expect(connectOutcome(PAYLOADS.connected).connected).toBe(true);
    for (const payload of [
      PAYLOADS.choose_account,
      PAYLOADS.no_accounts,
      PAYLOADS.error,
      { status: 'something_new' },
      {},
      null,
      undefined,
      'connected',
    ]) {
      const outcome = connectOutcome(payload);
      expect(outcome.connected).toBe(false);
      expect(outcome.title).not.toBe('Connected — you can close this tab');
      expect(outcome.detail).toContain('Nothing has been connected');
    }
  });
});

describe('opener-independent completion', () => {
  it('broadcasts only a non-sensitive completion signal without an opener', () => {
    const page = open(
      { status: 'connected', provider: 'youtube', connectionId: 'secret-id' },
      false,
    );
    expect(page.signals).toEqual([
      { provider: 'youtube', outcome: 'success', time: expect.any(Number) },
    ]);
    expect(JSON.stringify(page.signals)).not.toContain('secret-id');
  });
  it('announces failure without broadcasting its reason', () => {
    const page = open({ status: 'error', error: 'private reason' }, false);
    expect(page.signals).toEqual([
      { provider: 'unknown', outcome: 'failure', time: expect.any(Number) },
    ]);
    expect(page.detail).toContain('private reason');
  });
  it('does not announce success while an account still needs choosing', () => {
    expect(open(PAYLOADS.choose_account, false).signals).toEqual([]);
  });
  it('has an explicit close action and a Connections fallback', () => {
    const html = connectPopupHtml(PAYLOADS.connected);
    expect(html).toContain('id="close">Close this tab');
    expect(html).toContain('href="/connections">Back to Connections');
  });
});
