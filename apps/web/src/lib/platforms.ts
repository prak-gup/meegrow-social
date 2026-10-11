import {
  FacebookLogo,
  InstagramLogo,
  LinkedinLogo,
  YoutubeLogo,
  XLogo,
  GoogleLogo,
  WordpressLogo,
  Plugs,
  type IconComponent,
} from './icons';

export interface PlatformMeta {
  label: string;
  Icon: IconComponent;
  /** Tailwind bg class from the --brand-* tokens. */
  brand: string;
  blurb: string;
}

const PLATFORM: Record<string, PlatformMeta> = {
  facebook: {
    label: 'Facebook Page',
    Icon: FacebookLogo,
    brand: 'bg-brand-facebook',
    blurb: 'Publish to a Facebook Page',
  },
  instagram: {
    label: 'Instagram',
    Icon: InstagramLogo,
    brand: 'bg-brand-instagram',
    blurb: 'Publish to an Instagram Business account',
  },
  gmb: {
    label: 'Google Business',
    Icon: GoogleLogo,
    brand: 'bg-brand-gmb',
    blurb: 'Post to a Business Profile',
  },
  linkedin: {
    label: 'LinkedIn',
    Icon: LinkedinLogo,
    brand: 'bg-brand-linkedin',
    blurb: 'Post to a personal profile',
  },
  'linkedin-page': {
    label: 'LinkedIn Page',
    Icon: LinkedinLogo,
    brand: 'bg-brand-linkedin',
    blurb: 'Post to a Company Page',
  },
  x: { label: 'X', Icon: XLogo, brand: 'bg-brand-x', blurb: 'Post to X (Twitter)' },
  youtube: {
    label: 'YouTube',
    Icon: YoutubeLogo,
    brand: 'bg-brand-youtube',
    blurb: 'Upload to a channel',
  },
  wordpress: {
    label: 'WordPress',
    Icon: WordpressLogo,
    brand: 'bg-brand-wordpress',
    blurb: 'Publish blog articles to a site',
  },
};

/** Icon, label and brand tile for a provider; unknown (dev/fake) providers get a generic plug. */
export function platformMeta(p: { identifier: string; displayName: string }): PlatformMeta {
  return (
    PLATFORM[p.identifier] ?? {
      label: p.displayName,
      Icon: Plugs,
      brand: 'bg-muted',
      blurb: 'Test provider (dev)',
    }
  );
}

const PLATFORM_COLOR: Record<string, string> = {
  facebook: 'hsl(var(--brand-facebook))',
  instagram: 'hsl(var(--brand-instagram))',
  gmb: 'hsl(var(--brand-gmb))',
  linkedin: 'hsl(var(--brand-linkedin))',
  'linkedin-page': 'hsl(var(--brand-linkedin))',
  x: 'hsl(var(--brand-x))',
  youtube: 'hsl(var(--brand-youtube))',
  wordpress: 'hsl(var(--brand-wordpress))',
};

/**
 * The colour a platform is drawn in on a chart: its brand token, so a platform is the same colour
 * in every chart of a screen. Unknown (dev/fake) providers are muted grey.
 */
export function platformColor(identifier: string): string {
  return PLATFORM_COLOR[identifier] ?? 'hsl(var(--muted))';
}

/**
 * The product's name as a client meets it. There is no agency/operator entity in the data model (a
 * workspace is the client; a user is a person), and this is the name the platform's own consent
 * screen shows for the app, so the invite pages use the same one.
 */
export const PRODUCT_NAME = 'Meegrow Social';

/** Whose login a platform's consent actually is — a Facebook Page and Instagram both sign in with Facebook. */
const SIGN_IN_WITH: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Facebook',
  gmb: 'Google',
  youtube: 'Google',
  linkedin: 'LinkedIn',
  'linkedin-page': 'LinkedIn',
  x: 'X',
  wordpress: 'WordPress',
};

export function signInName(p: { provider: string; providerDisplayName: string }): string {
  return SIGN_IN_WITH[p.provider] ?? p.providerDisplayName;
}
