import {
  FacebookLogo,
  InstagramLogo,
  LinkedinLogo,
  YoutubeLogo,
  XLogo,
  GoogleLogo,
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
