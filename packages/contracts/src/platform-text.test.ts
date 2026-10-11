import { describe, expect, it } from 'vitest';
import {
  blueskyFacets,
  byteRange,
  discordContent,
  findHashtags,
  findMentions,
  findUrls,
  graphemeLength,
  platformTextLimit,
  slackMrkdwn,
  telegramHtml,
  utf8Length,
} from './platform-text.js';

const utf8 = (text: string) => Buffer.from(text, 'utf8');
/** What a facet points at, read back the way a Bluesky client does: by slicing the BYTES. */
const facetText = (text: string, index: { byteStart: number; byteEnd: number }) =>
  utf8(text).subarray(index.byteStart, index.byteEnd).toString('utf8');

describe('graphemeLength', () => {
  it('counts what a reader sees as one character as one', () => {
    expect(graphemeLength('')).toBe(0);
    expect(graphemeLength('hello')).toBe(5);
    expect(graphemeLength('👍')).toBe(1); // 2 UTF-16 units, 4 bytes
    expect(graphemeLength('👨‍👩‍👧')).toBe(1); // 8 UTF-16 units, 18 bytes
    expect(graphemeLength('🇮🇳')).toBe(1); // two regional indicators
    expect(graphemeLength('é')).toBe(1); // e + combining acute
  });

  it('counts a Devanagari syllable with its vowel sign as one', () => {
    expect(graphemeLength('हिंदी')).toBe(2); // हिं + दी — five code points
    expect('हिंदी'.length).toBe(5);
  });

  it('differs from the UTF-16 length and the byte length for the same text', () => {
    const text = 'नमस्कार 👋🏽';
    expect(graphemeLength(text)).toBeLessThan(text.length);
    expect(text.length).toBeLessThan(utf8Length(text));
  });
});

describe('utf8Length', () => {
  it.each(['', 'abc', 'é', 'हिंदी', '👨‍👩‍👧 family', '€100 — ok', '日本語'])(
    'matches the real encoder for %j',
    (text) => {
      expect(utf8Length(text)).toBe(utf8(text).byteLength);
    },
  );
});

describe('findUrls', () => {
  it('finds each address and leaves the sentence punctuation outside it', () => {
    const text = 'Read https://example.com/a, then (https://example.org/b). Done!';
    expect(findUrls(text).map((u) => u.url)).toEqual([
      'https://example.com/a',
      'https://example.org/b',
    ]);
  });

  it('keeps a closing bracket that belongs to the address', () => {
    const [found] = findUrls('See https://en.wikipedia.org/wiki/Mumbai_(city).');
    expect(found?.url).toBe('https://en.wikipedia.org/wiki/Mumbai_(city)');
  });

  it('ends an address at the first non-ASCII character', () => {
    const text = 'देखें https://example.com/नया।';
    expect(findUrls(text).map((u) => u.url)).toEqual(['https://example.com/']);
    expect(findUrls('देखें https://example.com।')[0]?.url).toBe('https://example.com');
  });

  it('does not take a bare domain, another scheme, or a host without a dot for a link', () => {
    expect(findUrls('example.com and ftp://example.com and https://localhost/x')).toEqual([]);
    expect(findUrls('javascript:alert(1)')).toEqual([]);
  });

  it('reports spans that slice back to the address', () => {
    const text = '👨‍👩‍👧 https://a.example/x and https://b.example/y';
    for (const span of findUrls(text)) expect(text.slice(span.start, span.end)).toBe(span.url);
  });
});

describe('findHashtags / findMentions', () => {
  it('finds tags in any script and drops trailing punctuation', () => {
    const text = '#दिवाली की शुभकामनाएं! #Diwali2026, #festive.';
    expect(findHashtags(text).map((t) => t.tag)).toEqual(['दिवाली', 'Diwali2026', 'festive']);
  });

  it('does not treat a number, a mid-word hash, or a lone hash as a tag', () => {
    expect(findHashtags('#1 choice, issue#42, # alone, C#')).toEqual([]);
  });

  it('finds handles and ignores an email address and a bare @word', () => {
    const found = findMentions(
      'thanks @Alice.bsky.social and (@bob.example.com), mail a@b.co @carol',
    );
    expect(found.map((m) => m.handle)).toEqual(['alice.bsky.social', 'bob.example.com']);
  });
});

describe('blueskyFacets', () => {
  it('gives BYTE offsets, which differ from string indices once the text is not ASCII', () => {
    const text = 'नमस्ते 🙏 देखें https://example.com/diwali और https://example.org/x?y=1 #दिवाली';
    const facets = blueskyFacets(text);
    expect(facets.map((f) => f.features[0])).toEqual([
      { $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/diwali' },
      { $type: 'app.bsky.richtext.facet#link', uri: 'https://example.org/x?y=1' },
      { $type: 'app.bsky.richtext.facet#tag', tag: 'दिवाली' },
    ]);
    expect(facets.map((f) => facetText(text, f.index))).toEqual([
      'https://example.com/diwali',
      'https://example.org/x?y=1',
      '#दिवाली',
    ]);
    // Where the first link starts as a string index is not where it starts in bytes.
    const at = text.indexOf('https://');
    expect(facets[0]!.index.byteStart).toBe(utf8(text.slice(0, at)).byteLength);
    expect(facets[0]!.index.byteStart).toBeGreaterThan(at);
  });

  it('reproduces the offsets of the documented example', () => {
    // docs.bsky.app "Posts" guide: mention 23–35, link 74–108.
    const text =
      '✨ example mentioning @atproto.com to share the URL 👨‍❤️‍👨 https://en.wikipedia.org/wiki/CBOR.';
    const facets = blueskyFacets(
      text,
      new Map([['atproto.com', 'did:plc:ewvi7nxzyoun6zhxrhs64oiz']]),
    );
    expect(facets).toEqual([
      {
        index: { byteStart: 23, byteEnd: 35 },
        features: [
          { $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz' },
        ],
      },
      {
        index: { byteStart: 74, byteEnd: 108 },
        features: [
          { $type: 'app.bsky.richtext.facet#link', uri: 'https://en.wikipedia.org/wiki/CBOR' },
        ],
      },
    ]);
  });

  it('leaves a handle that did not resolve as plain text', () => {
    expect(blueskyFacets('hello @nobody.example.com')).toEqual([]);
  });

  it('does not make a tag or a mention out of part of an address', () => {
    const text = 'https://example.com/page#section and https://example.com/@user.example.com';
    const facets = blueskyFacets(text, new Map([['user.example.com', 'did:plc:x']]));
    expect(facets.map((f) => f.features[0]!.$type)).toEqual([
      'app.bsky.richtext.facet#link',
      'app.bsky.richtext.facet#link',
    ]);
  });

  it('never produces overlapping or out-of-range facets', () => {
    const text = '🎉🎉 #a https://x.example/#b #c @d.example.com https://y.example 👨‍👩‍👧';
    const facets = blueskyFacets(text, new Map([['d.example.com', 'did:plc:d']]));
    const total = utf8(text).byteLength;
    let previousEnd = 0;
    for (const facet of facets) {
      expect(facet.index.byteStart).toBeGreaterThanOrEqual(previousEnd);
      expect(facet.index.byteEnd).toBeGreaterThan(facet.index.byteStart);
      expect(facet.index.byteEnd).toBeLessThanOrEqual(total);
      previousEnd = facet.index.byteEnd;
    }
    expect(facets).toHaveLength(5);
  });

  it('byteRange counts an emoji before the span as four bytes, not two', () => {
    expect(byteRange('👍 ok', { start: 3, end: 5 })).toEqual({ byteStart: 5, byteEnd: 7 });
  });
});

describe('telegramHtml', () => {
  it('escapes exactly the three characters HTML mode reserves', () => {
    expect(telegramHtml('1 < 2 && 3 > 2')).toBe('1 &lt; 2 &amp;&amp; 3 &gt; 2');
  });

  it('turns typed tags and entities into the text they were', () => {
    expect(telegramHtml('<b>bold</b> &amp; <a href="https://x.example">x</a>')).toBe(
      '&lt;b&gt;bold&lt;/b&gt; &amp;amp; &lt;a href="https://x.example"&gt;x&lt;/a&gt;',
    );
  });

  it('leaves everything else alone — Markdown characters mean nothing in HTML mode', () => {
    const text = '*not bold* _not italic_ `code` [x](y) नमस्ते 👋 https://example.com/a_b';
    expect(telegramHtml(text)).toBe(text);
  });
});

describe('discordContent', () => {
  it('escapes the characters Discord reads as formatting', () => {
    expect(discordContent('*bold* _it_ ~~no~~ `code` ||spoiler||')).toBe(
      '\\*bold\\* \\_it\\_ \\~\\~no\\~\\~ \\`code\\` \\|\\|spoiler\\|\\|',
    );
  });

  it('defuses mentions, channels, custom emoji and masked links', () => {
    expect(discordContent('<@123> <@&456> <#789> <:x:1> [click](https://evil.example)')).toBe(
      '\\<@123> \\<@&456> \\<#789> \\<:x:1> \\[click](https://evil.example)',
    );
  });

  it('escapes headings, quotes and lists only where they start a line', () => {
    expect(discordContent('# Sale\n> quote\n- item\n  -# small\na - b # c > d')).toBe(
      '\\# Sale\n\\> quote\n\\- item\n  \\-# small\na - b # c > d',
    );
  });

  it('leaves an address untouched so it still links', () => {
    const url = 'https://example.com/a_b_c?x=*y*&z=~1';
    expect(discordContent(`see ${url} now_`)).toBe(`see ${url} now\\_`);
  });

  it('escapes a backslash, so a typed escape cannot undo the next one', () => {
    expect(discordContent('\\*x*')).toBe('\\\\\\*x\\*');
  });

  it('does not treat the text after an address as the start of a line', () => {
    expect(discordContent('https://example.com - fine\n- list')).toBe(
      'https://example.com - fine\n\\- list',
    );
  });
});

describe('slackMrkdwn', () => {
  it('escapes the three characters Slack reserves', () => {
    expect(slackMrkdwn('Tom & Jerry <3 > 2')).toBe('Tom &amp; Jerry &lt;3 &gt; 2');
  });

  it('defuses special mentions, which are all written with angle brackets', () => {
    expect(slackMrkdwn('<!channel> <!here> <@U123> <#C123|general>')).toBe(
      '&lt;!channel&gt; &lt;!here&gt; &lt;@U123&gt; &lt;#C123|general&gt;',
    );
  });

  it('writes each address as an explicit link, escaping what Slack reserves inside it', () => {
    expect(slackMrkdwn('go https://example.com/a?b=1&c=2|label now.')).toBe(
      'go <https://example.com/a?b=1&amp;c=2>|label now.',
    );
  });
});

describe('platformTextLimit', () => {
  it('measures Bluesky in graphemes', () => {
    const limit = platformTextLimit('bluesky', '👨‍👩‍👧'.repeat(10));
    expect(limit).toEqual({ max: 300, unit: 'characters', length: 10 });
  });

  it('gives Telegram a quarter of the room once there is media', () => {
    expect(platformTextLimit('telegram', 'a < b')).toMatchObject({ max: 4096, length: 5 });
    expect(platformTextLimit('telegram', 'a < b', true)).toMatchObject({ max: 1024, length: 5 });
  });

  it('measures Discord and Slack as the text that is sent, escapes included', () => {
    expect(platformTextLimit('discord', '*a*')).toMatchObject({ max: 2000, length: 5 });
    expect(platformTextLimit('slack', 'a & b')).toMatchObject({ max: 3000, length: 9 });
  });

  it('knows nothing about other platforms', () => {
    expect(platformTextLimit('facebook', 'x')).toBeNull();
    expect(platformTextLimit('wordpress', 'x')).toBeNull();
  });
});
