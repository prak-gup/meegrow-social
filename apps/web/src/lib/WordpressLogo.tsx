import { forwardRef } from 'react';
import type { Icon, IconProps } from '@phosphor-icons/react';

/**
 * The icon set (Phosphor) has no WordPress mark, so this is the one icon drawn here: a "W" in a
 * ring, on Phosphor's 256 grid and taking the same props, so it drops in wherever a platform icon
 * goes (lib/platforms.ts). `weight` is accepted and ignored — there is one drawing.
 */
export const WordpressLogo: Icon = forwardRef<SVGSVGElement, IconProps>(
  (
    { size = '1em', color = 'currentColor', weight: _weight, mirrored: _mirrored, alt, ...rest },
    ref,
  ) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      stroke={color}
      strokeWidth={20}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {alt ? <title>{alt}</title> : null}
      <circle cx="128" cy="128" r="100" />
      <path d="M72 92l30 84 26-70 26 70 30-84" />
    </svg>
  ),
);
WordpressLogo.displayName = 'WordpressLogo';
