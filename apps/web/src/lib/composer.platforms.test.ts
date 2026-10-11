import { describe, expect, it } from 'vitest';
import { isMessageProvider, platformCounts, previewNote } from './composer';

const targets = (...providers: string[]) => providers.map((provider) => ({ provider }));

describe('platformCounts', () => {
  it('counts a caption the way each selected platform does', () => {
    const caption = '👨‍👩‍👧 *big* news & more';
    const counts = platformCounts(targets('bluesky', 'telegram', 'discord', 'slack'), caption, 0);
    expect(Object.fromEntries(counts.map((c) => [c.provider, [c.length, c.max]]))).toEqual({
      // One family emoji is one character to Bluesky, eight UTF-16 units to the rest.
      bluesky: [19, 300],
      telegram: [26, 4096],
      // Discord is sent the two asterisks escaped; Slack the ampersand as an entity.
      discord: [28, 2000],
      slack: [30, 3000],
    });
    expect(counts.every((c) => !c.over)).toBe(true);
  });

  it('has one entry per platform, however many of its accounts are selected', () => {
    const counts = platformCounts(targets('bluesky', 'bluesky', 'slack', 'bluesky'), 'x', 0);
    expect(counts.map((c) => c.provider)).toEqual(['bluesky', 'slack']);
  });

  it('says nothing for platforms with no rule of their own here', () => {
    expect(platformCounts(targets('facebook', 'instagram', 'wordpress', 'fake'), 'x', 0)).toEqual(
      [],
    );
    expect(platformCounts([], 'x', 0)).toEqual([]);
  });

  it('flags the platform that is over while the others still fit', () => {
    const counts = platformCounts(targets('bluesky', 'discord'), 'a'.repeat(301), 0);
    expect(counts.map((c) => [c.provider, c.over])).toEqual([
      ['bluesky', true],
      ['discord', false],
    ]);
  });

  it('gives Telegram a quarter of the room once media is attached', () => {
    const text = 'a'.repeat(2000);
    expect(platformCounts(targets('telegram'), text, 0)[0]).toMatchObject({
      max: 4096,
      over: false,
    });
    expect(platformCounts(targets('telegram'), text, 1)[0]).toMatchObject({
      max: 1024,
      over: true,
    });
  });

  it('counts Hindi by what a reader sees on Bluesky', () => {
    const [bluesky] = platformCounts(targets('bluesky'), 'हिंदी'.repeat(150), 0);
    expect(bluesky).toMatchObject({ length: 300, over: false });
  });
});

describe('isMessageProvider / previewNote', () => {
  it('draws the three channel platforms as a message, and Bluesky as a post', () => {
    for (const p of ['telegram', 'discord', 'slack']) expect(isMessageProvider(p)).toBe(true);
    for (const p of ['bluesky', 'facebook', 'wordpress', 'fake'])
      expect(isMessageProvider(p)).toBe(false);
  });

  it('says in the preview that Slack gives back no link', () => {
    expect(previewNote('slack')).toMatch(/no link to the message/);
  });

  it('says that Discord pings nobody and Telegram formats nothing', () => {
    expect(previewNote('discord')).toMatch(/nobody is pinged/);
    expect(previewNote('telegram')).toMatch(/plain text/);
    expect(previewNote('bluesky')).toMatch(/clickable/);
    expect(previewNote('facebook')).toBeNull();
  });
});
