/** @type {import('tailwindcss').Config} */
// Token mapping (Tailwind v3). Colors are HSL CSS vars defined in index.css. Light-only.
// Density pass: a compact work-tool scale (13-14px text, 32px controls, hairlines, 6-8px radii).
// Rausch is the single accent and appears once per screen (the Create post action).
// Origin of the palette: docs/dev/DESIGN-airbnb.md; the SCALE here deliberately departs from it.
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
          wordpress: 'hsl(var(--brand-wordpress) / <alpha-value>)',
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
      // Typography tokens replace arbitrary text-[Npx] values. The stock Tailwind steps are
      // overridden so the whole app inherits the compact scale: sm is table/control text.
      fontSize: {
        micro: ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1rem' }],
        caption: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        body: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.25rem' }],
        lg: ['1rem', { lineHeight: '1.5rem' }],
        xl: ['1.125rem', { lineHeight: '1.5rem' }],
        '2xl': ['1.25rem', { lineHeight: '1.75rem' }],
        '3xl': ['1.5rem', { lineHeight: '2rem' }],
        wordmark: ['1rem', { lineHeight: '1.5rem' }],
        title: ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em' }],
      },
      spacing: { 4.5: '1.125rem', sidebar: '11rem' },
      minWidth: { field: '17.5rem', switcher: '9.5rem' },
      minHeight: { textarea: '6rem' },
      width: { 'card-sm': '22.5rem' },
      aspectRatio: { cover: '20 / 13' },
      borderWidth: { 1.5: '1.5px' },
      gridTemplateColumns: {
        tiles: 'repeat(auto-fill, minmax(14.875rem, 1fr))',
        clients: '2fr 1fr 1fr auto',
        upcoming: '8.125rem 1fr auto',
        // Composer panel: content | accounts over preview at lg; content | accounts | preview at xl.
        composer: 'minmax(0, 1fr) 24rem',
        'composer-wide': 'minmax(0, 1fr) 25rem 19rem',
        // Content grid: as many 264px+ cards as fit (4 at 1512, 2 on a tablet, 1 on a phone).
        posts: 'repeat(auto-fill, minmax(16.5rem, 1fr))',
        // KPI strip: cells share the row and wrap; each is at least 9.5rem.
        kpis: 'repeat(auto-fit, minmax(9.5rem, 1fr))',
      },
      // A row sized to its content, then one that takes what is left.
      gridTemplateRows: { 'head-fill': 'auto 1fr' },
      borderRadius: {
        xs: '4px',
        sm: '6px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        full: '9999px',
      },
      boxShadow: {
        // Overlays only (menus, popovers, modals, the drawer). Cards and rows use hairlines instead.
        1: 'rgba(0,0,0,0.04) 0 0 0 1px, rgba(0,0,0,0.08) 0 6px 20px -4px',
      },
      maxWidth: { content: '90rem', sheet: '80rem' },
    },
  },
  plugins: [],
};
