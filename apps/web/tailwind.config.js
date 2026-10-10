/** @type {import('tailwindcss').Config} */
// Airbnb DLS token mapping (Tailwind v3). Colors are HSL CSS vars defined in index.css.
// Light-only; Rausch is the single accent. See docs/dev/DESIGN-airbnb.md.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1.5rem', screens: { '2xl': '1280px' } },
    extend: {
      colors: {
        rausch: {
          DEFAULT: 'hsl(var(--rausch) / <alpha-value>)',
          active: 'hsl(var(--rausch-active) / <alpha-value>)',
          disabled: 'hsl(var(--rausch-disabled) / <alpha-value>)',
        },
        error: 'hsl(var(--error) / <alpha-value>)',
        ink: 'hsl(var(--ink) / <alpha-value>)',
        'body-ink': 'hsl(var(--body-ink) / <alpha-value>)',
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          soft: 'hsl(var(--muted-soft) / <alpha-value>)',
        },
        canvas: 'hsl(var(--canvas) / <alpha-value>)',
        surface: {
          soft: 'hsl(var(--surface-soft) / <alpha-value>)',
          strong: 'hsl(var(--surface-strong) / <alpha-value>)',
        },
        hairline: {
          DEFAULT: 'hsl(var(--hairline) / <alpha-value>)',
          soft: 'hsl(var(--hairline-soft) / <alpha-value>)',
          strong: 'hsl(var(--border-strong) / <alpha-value>)',
        },
        scrim: 'hsl(var(--scrim) / <alpha-value>)',
        // Third-party brand marks (platform tiles) and client identity hues (content axis).
        brand: {
          facebook: 'hsl(var(--brand-facebook) / <alpha-value>)',
          instagram: 'hsl(var(--brand-instagram) / <alpha-value>)',
          gmb: 'hsl(var(--brand-gmb) / <alpha-value>)',
          linkedin: 'hsl(var(--brand-linkedin) / <alpha-value>)',
          x: 'hsl(var(--brand-x) / <alpha-value>)',
          youtube: 'hsl(var(--brand-youtube) / <alpha-value>)',
        },
        chart: {
          1: 'hsl(var(--chart-1) / <alpha-value>)',
          2: 'hsl(var(--chart-2) / <alpha-value>)',
          3: 'hsl(var(--chart-3) / <alpha-value>)',
          4: 'hsl(var(--chart-4) / <alpha-value>)',
          5: 'hsl(var(--chart-5) / <alpha-value>)',
        },
        status: {
          ok: 'hsl(var(--status-ok) / <alpha-value>)',
          warn: 'hsl(var(--status-warn) / <alpha-value>)',
          bad: 'hsl(var(--status-bad) / <alpha-value>)',
          idle: 'hsl(var(--status-idle) / <alpha-value>)',
        },
      },
      // Typography tokens replace arbitrary text-[Npx] values.
      fontSize: {
        micro: ['0.6875rem', { lineHeight: '1rem' }],
        caption: ['0.8125rem', { lineHeight: '1.25rem' }],
        body: ['0.9375rem', { lineHeight: '1.5rem' }],
        wordmark: ['1.1875rem', { lineHeight: '1.5rem' }],
        title: ['1.625rem', { lineHeight: '2rem', letterSpacing: '-0.01em' }],
      },
      spacing: { 4.5: '1.125rem', sidebar: '15rem' },
      minWidth: { field: '17.5rem', switcher: '9.5rem' },
      minHeight: { textarea: '6rem' },
      width: { 'card-sm': '22.5rem' },
      aspectRatio: { cover: '20 / 13' },
      borderWidth: { 1.5: '1.5px' },
      gridTemplateColumns: {
        tiles: 'repeat(auto-fill, minmax(14.875rem, 1fr))',
        clients: '2fr 1fr 1fr auto',
        upcoming: '8.125rem 1fr auto',
        composer: 'minmax(0, 3fr) minmax(0, 2fr)',
      },
      borderRadius: {
        xs: '4px',
        sm: '8px',
        md: '14px',
        lg: '20px',
        xl: '32px',
        full: '9999px',
      },
      boxShadow: {
        1: 'rgba(0,0,0,0.02) 0 0 0 1px, rgba(0,0,0,0.04) 0 2px 6px 0, rgba(0,0,0,0.1) 0 4px 8px 0',
      },
      maxWidth: { content: '90rem' },
    },
  },
  plugins: [],
};
