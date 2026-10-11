import { describe, expect, it } from 'vitest';
import { passwordConnectInput, siteCheck, type SiteCheck } from '@meegrow-social/contracts';
import {
  SITE_PASSWORD_MAX,
  SITE_USERNAME_MAX,
  connectionSubline,
  defaultConnectMethod,
  methodGuidance,
  separateAddressesNote,
  siteLoginProblems,
} from './wordpress';

/**
 * The Connect dialog's decisions once the server has looked at a site: which method it starts on,
 * what it says when the recommended one is unavailable, and what the login form checks before it
 * sends anything. Pure — the dialog only lays these out.
 */

const SITE = 'https://blog.example.com';
const base: SiteCheck = {
  entered: SITE,
  name: 'Ecolive & Co',
  siteAddress: SITE,
  homeAddress: SITE,
  separateAddresses: false,
  approval: { available: true },
  password: { available: true, endpoint: `${SITE}/xmlrpc.php` },
  ticket: 'sealed',
};
const noApproval: SiteCheck['approval'] = {
  available: false,
  reason: 'application_passwords_unavailable',
  message: 'Application Passwords are not available on this site.',
};
const noPassword: SiteCheck['password'] = {
  available: false,
  reason: 'disabled',
  message: 'XML-RPC is switched off on this site.',
};

describe('defaultConnectMethod', () => {
  it('starts on approval wherever the site offers it — no password is typed that way', () => {
    expect(defaultConnectMethod(base)).toBe('approval');
    expect(defaultConnectMethod({ ...base, password: noPassword })).toBe('approval');
  });

  it('starts on the username and password only where approval is unavailable', () => {
    expect(defaultConnectMethod({ ...base, approval: noApproval })).toBe('password');
  });

  it('selects nothing when the site can be connected neither way', () => {
    expect(defaultConnectMethod({ approval: noApproval, password: noPassword })).toBeNull();
  });
});

describe('methodGuidance', () => {
  it('says nothing when approval is available', () => {
    expect(methodGuidance(base)).toBeNull();
    expect(methodGuidance({ ...base, password: noPassword })).toBeNull();
  });

  it('offers the other method, plainly, instead of a dead end', () => {
    expect(methodGuidance({ ...base, approval: noApproval })).toEqual({
      kind: 'switch',
      title: 'This site cannot be connected by approval',
      detail: 'It can be connected with a WordPress username and password instead.',
    });
  });

  it('says so when nothing works', () => {
    const guidance = methodGuidance({ approval: noApproval, password: noPassword });
    expect(guidance?.kind).toBe('stop');
    expect(guidance?.title).toBe('This site cannot be connected yet');
  });
});

describe('separateAddressesNote', () => {
  it('names both addresses of a WordPress that is read at one and managed at another', () => {
    expect(
      separateAddressesNote({
        separateAddresses: true,
        siteAddress: 'https://admin.example.com',
        homeAddress: 'https://example.com/blog',
      }),
    ).toBe(
      'This WordPress has two addresses: visitors read it at https://example.com/blog, and it ' +
        'is managed at https://admin.example.com. Either one works here.',
    );
  });

  it('says nothing for an ordinary site, or when the addresses are not known', () => {
    expect(separateAddressesNote(base)).toBeNull();
    expect(
      separateAddressesNote({ separateAddresses: true, siteAddress: null, homeAddress: SITE }),
    ).toBeNull();
  });
});

describe('siteLoginProblems', () => {
  it('lets a filled-in login through', () => {
    expect(siteLoginProblems({ username: 'priya', password: 'p' })).toEqual({});
  });

  it('asks for whichever field is empty, and treats a username of spaces as empty', () => {
    expect(siteLoginProblems({ username: '   ', password: '' })).toEqual({
      username: 'Enter the WordPress username.',
      password: 'Enter the password.',
    });
  });

  it('never trims a password: one made of spaces is still a password', () => {
    expect(siteLoginProblems({ username: 'priya', password: '   ' })).toEqual({});
  });

  it('refuses what the server would refuse — the limits match the contract', () => {
    const over = { ticket: 't', username: 'u'.repeat(SITE_USERNAME_MAX + 1), password: 'p' };
    expect(siteLoginProblems(over).username).toBeDefined();
    expect(passwordConnectInput.safeParse(over).success).toBe(false);
    const fits = { ticket: 't', username: 'u'.repeat(SITE_USERNAME_MAX), password: 'p' };
    expect(siteLoginProblems(fits)).toEqual({});
    expect(passwordConnectInput.safeParse(fits).success).toBe(true);

    const long = { ticket: 't', username: 'u', password: 'p'.repeat(SITE_PASSWORD_MAX + 1) };
    expect(siteLoginProblems(long).password).toBeDefined();
    expect(passwordConnectInput.safeParse(long).success).toBe(false);
    const max = { ticket: 't', username: 'u', password: 'p'.repeat(SITE_PASSWORD_MAX) };
    expect(siteLoginProblems(max)).toEqual({});
    expect(passwordConnectInput.safeParse(max).success).toBe(true);
  });
});

describe('connectionSubline', () => {
  it('says when a connection holds a login password', () => {
    expect(connectionSubline('WordPress', { externalId: SITE, method: 'password' })).toBe(
      `WordPress · password · ${SITE}`,
    );
  });

  it('reads as before for an approved connection, and for every other platform', () => {
    expect(connectionSubline('WordPress', { externalId: SITE, method: 'approval' })).toBe(
      `WordPress · ${SITE}`,
    );
    expect(connectionSubline('Facebook', { externalId: '1234' })).toBe('Facebook · 1234');
  });
});

describe('the site-check contract', () => {
  it('accepts what the dialog is given, with and without a ticket', () => {
    expect(siteCheck.safeParse(base).success).toBe(true);
    expect(
      siteCheck.safeParse({
        ...base,
        approval: noApproval,
        password: noPassword,
        ticket: undefined,
      }).success,
    ).toBe(true);
  });
});
