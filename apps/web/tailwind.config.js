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
          DEFAULT: 'hsl(var(--rausch))',
          active: 'hsl(var(--rausch-active))',
          disabled: 'hsl(var(--rausch-disabled))',
        },
        error: 'hsl(var(--error))',
        ink: 'hsl(var(--ink))',
        'body-ink': 'hsl(var(--body-ink))',
        muted: { DEFAULT: 'hsl(var(--muted))', soft: 'hsl(var(--muted-soft))' },
        canvas: 'hsl(var(--canvas))',
        surface: {
          soft: 'hsl(var(--surface-soft))',
          strong: 'hsl(var(--surface-strong))',
        },
        hairline: {
          DEFAULT: 'hsl(var(--hairline))',
          soft: 'hsl(var(--hairline-soft))',
          strong: 'hsl(var(--border-strong))',
        },
        status: {
          ok: 'hsl(var(--status-ok))',
          warn: 'hsl(var(--status-warn))',
          bad: 'hsl(var(--status-bad))',
          idle: 'hsl(var(--status-idle))',
        },
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
      maxWidth: { content: '1280px' },
    },
  },
  plugins: [],
};
