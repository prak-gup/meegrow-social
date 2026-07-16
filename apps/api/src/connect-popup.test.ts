import { afterEach, describe, expect, it } from 'vitest';
import { connectPopupHtml } from './server.js';

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

  it('renders the outcome as text when there is no opener', () => {
    const html = connectPopupHtml({ status: 'error', error: 'connect flow expired' });
    expect(html).toContain('if (window.opener)');
    expect(html).toContain('Connect failed');
    expect(html).toContain('connect flow expired');
  });
});
