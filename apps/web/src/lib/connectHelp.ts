import type { OutstandingInviteView } from '@meegrow-social/contracts';
import { PRODUCT_NAME } from './platforms';

/**
 * The words around connecting an account that are easy to get wrong and worth testing: why a
 * platform login can come back with nothing to connect, what a client should pick on the platform's
 * screens, and how an outstanding invite link is described. Pure — the screens only lay it out.
 */

/** A Facebook Page and Instagram both go through Meta's consent screens, with the same pitfalls. */
const META = new Set(['facebook', 'instagram']);

export type HelpAudience = 'client' | 'operator';

export interface MissingAccountHelp {
  /** What happened, in one sentence. */
  lead: string;
  /** The real reasons, each with the step that fixes it. Empty when we know of none. */
  causes: { cause: string; fix: string }[];
}

/**
 * Why a login offered no account (or not the wanted one), and what to do about it.
 *
 * On Meta there are two real causes, both seen live: the Page was not ticked — a returning person
 * is asked "Continue as …?", and Continue reuses the earlier choice without showing the list — or
 * the Page is owned through a Meta Business portfolio, which Meta only lists once the app's login
 * has business access. The client can fix the first; only the operator can fix the second.
 */
export function missingAccountHelp(
  flow: { provider: string; providerDisplayName: string },
  audience: HelpAudience,
): MissingAccountHelp {
  if (!META.has(flow.provider)) {
    return {
      lead: `That ${flow.providerDisplayName} login didn’t offer any account that can be connected.`,
      causes: [],
    };
  }
  const instagram = flow.provider === 'instagram';
  const page = instagram ? 'Page and the Instagram account linked to it' : 'Page';
  const lead = instagram
    ? 'Facebook didn’t share an Instagram account with us. It has to be a Business or Creator account linked to a Facebook Page you manage. If it is, the cause is one of these two.'
    : 'Facebook didn’t share a Page with us. If you manage the Page, the cause is one of these two.';

  return {
    lead,
    causes: [
      {
        cause: `The ${page} ${instagram ? 'weren’t' : 'wasn’t'} ticked on Facebook’s screens.`,
        fix: `Start again. If Facebook asks “Continue as …?”, choose “Edit settings” (not Continue), then tick the ${page}.`,
      },
      audience === 'client'
        ? {
            cause:
              'The Page belongs to a business account on Facebook (a Meta Business portfolio).',
            fix: 'Start again and, if Facebook shows a “Choose the businesses” step, tick the business that owns the Page. If it never shows that step, tell the team that sent you this link: they have to switch on business access for their app before this can work.',
          }
        : {
            cause: `The Page is owned through a Meta Business portfolio, and ${PRODUCT_NAME}’s Facebook login has no business access.`,
            fix: 'In the Meta app dashboard, add the business_management permission to the Facebook Login for Business configuration this app uses. Then connect again and tick the business at “Choose the Businesses”.',
          },
    ],
  };
}

/**
 * One line for the invite page, before the client leaves for the platform: what they will be asked
 * to pick, and to pick only this business's. Meta's pickers default to every Page, Instagram account
 * and business the person has, now and in future. Null where we know of no such picker.
 */
export function pickOnlyThisBusiness(invite: {
  provider: string;
  workspaceName: string;
}): string | null {
  if (!META.has(invite.provider)) return null;
  const what =
    invite.provider === 'instagram'
      ? 'Pages and Instagram accounts'
      : 'Pages (and businesses, if you have any)';
  const only =
    invite.provider === 'instagram'
      ? `only the Page and Instagram account for ${invite.workspaceName}`
      : `only the Page for ${invite.workspaceName}`;
  return `Facebook will ask which ${what} to share. Choose ${only} — its own suggestion is everything you manage, now and in future.`;
}

const day = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** "Created 1 Oct · works until 15 Oct · opened 3 Oct, not finished" for an outstanding link. */
export function inviteStatusLine(
  invite: Pick<OutstandingInviteView, 'createdAt' | 'expiresAt' | 'lastStartedAt'>,
): string {
  const opened = invite.lastStartedAt
    ? `opened ${day(new Date(invite.lastStartedAt))}, not finished`
    : 'not opened yet';
  return `Created ${day(new Date(invite.createdAt))} · works until ${day(new Date(invite.expiresAt))} · ${opened}`;
}
