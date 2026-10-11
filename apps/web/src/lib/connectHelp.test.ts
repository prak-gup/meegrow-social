import { describe, expect, it } from 'vitest';
import { inviteStatusLine, missingAccountHelp, pickOnlyThisBusiness } from './connectHelp';

const fb = { provider: 'facebook', providerDisplayName: 'Facebook Page' };
const ig = { provider: 'instagram', providerDisplayName: 'Instagram' };

describe('missingAccountHelp', () => {
  it('gives a client both real Meta causes, each with a step they can take', () => {
    const help = missingAccountHelp(fb, 'client');
    expect(help.causes).toHaveLength(2);
    const [notTicked, businessOwned] = help.causes;
    expect(notTicked!.fix).toContain('Edit settings');
    expect(businessOwned!.cause).toContain('business account');
    expect(businessOwned!.fix).toContain('Choose the businesses');
    expect(businessOwned!.fix).toContain('tell the team that sent you this link');
    // A client cannot act on a permission name, so it is never put in front of them.
    expect(JSON.stringify(help)).not.toContain('business_management');
  });

  it('names the fix only an operator can make', () => {
    const [notTicked, businessOwned] = missingAccountHelp(fb, 'operator').causes;
    expect(notTicked!.fix).toContain('Edit settings');
    expect(businessOwned!.fix).toContain('business_management');
    expect(businessOwned!.fix).toContain('Facebook Login for Business configuration');
  });

  it('for Instagram, says what kind of account it has to be and asks for both ticks', () => {
    const help = missingAccountHelp(ig, 'client');
    expect(help.lead).toContain('Business or Creator');
    expect(help.causes[0]!.fix).toContain('Page and the Instagram account linked to it');
    expect(help.causes).toHaveLength(2);
  });

  it('claims no cause for a platform we have not seen this on', () => {
    const help = missingAccountHelp(
      { provider: 'linkedin-page', providerDisplayName: 'LinkedIn Page' },
      'operator',
    );
    expect(help.lead).toContain('LinkedIn Page');
    expect(help.causes).toEqual([]);
  });
});

describe('pickOnlyThisBusiness', () => {
  it('tells a Meta client to choose only this business’s Page, against Facebook’s default', () => {
    const line = pickOnlyThisBusiness({ provider: 'facebook', workspaceName: 'Ecolive' });
    expect(line).toContain('only the Page for Ecolive');
    expect(line).toContain('now and in future');
  });

  it('includes the Instagram account for an Instagram invite', () => {
    expect(pickOnlyThisBusiness({ provider: 'instagram', workspaceName: 'Ecolive' })).toContain(
      'only the Page and Instagram account for Ecolive',
    );
  });

  it('says nothing where the platform has no such picker', () => {
    expect(pickOnlyThisBusiness({ provider: 'x', workspaceName: 'Ecolive' })).toBeNull();
  });
});

describe('inviteStatusLine', () => {
  const base = {
    createdAt: new Date(2026, 9, 1, 12),
    expiresAt: new Date(2026, 9, 15, 12),
    lastStartedAt: null,
  };

  it('says a link nobody has opened is unopened', () => {
    const line = inviteStatusLine(base);
    expect(line).toContain('Created');
    expect(line).toContain('works until');
    expect(line).toContain('not opened yet');
  });

  it('says an opened link was not finished — a finished one is no longer listed', () => {
    const line = inviteStatusLine({ ...base, lastStartedAt: new Date(2026, 9, 3, 12) });
    expect(line).toContain('not finished');
    expect(line).not.toContain('not opened yet');
  });

  it('reads dates that arrived as JSON strings', () => {
    const line = inviteStatusLine({
      createdAt: '2026-10-01T12:00:00.000Z' as unknown as Date,
      expiresAt: '2026-10-15T12:00:00.000Z' as unknown as Date,
      lastStartedAt: null,
    });
    expect(line).not.toContain('Invalid Date');
  });
});
