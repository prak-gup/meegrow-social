import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { platformColor, platformMeta } from '../../lib/platforms';

export const platformLabel = (provider: string) =>
  platformMeta({ identifier: provider, displayName: provider }).label;

/** A platform's icon and name, in its chart colour — the key shared by every chart on the screen. */
export function PlatformName({ provider, className }: { provider: string; className?: string }) {
  const { Icon, label } = platformMeta({ identifier: provider, displayName: provider });
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <Icon
        size={14}
        weight="fill"
        aria-hidden="true"
        className="flex-none"
        style={{ color: platformColor(provider) }}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** One section of the screen: a titled card. `note` is the small print that says how to read it. */
export function Section({
  title,
  subtitle,
  actions,
  note,
  children,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        'min-w-0 rounded-lg border border-hairline bg-canvas p-4 shadow-[0_2px_8px_rgba(0,0,0,0.025)]',
        className,
      )}
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-0">
          <h2 className="text-body font-semibold text-ink">{title}</h2>
          {subtitle && <p className="text-caption text-muted">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
      {note && <p className="mt-2 text-caption text-muted">{note}</p>}
    </section>
  );
}

/**
 * What a section shows instead of a chart it cannot honestly draw: what is missing, and why.
 * Sized like the plot it replaces, so the page does not jump between filters.
 */
export function Insufficient({
  title,
  children,
  className,
}: {
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-start justify-center rounded-sm border border-dashed border-hairline-strong bg-surface-soft px-3 py-3 text-left',
        className,
      )}
    >
      <span aria-hidden="true" className="mb-2 text-2xl text-muted">
        ◇
      </span>
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <p className="mt-1 max-w-md text-caption text-muted">{children}</p>}
    </div>
  );
}

/** "—" for a value that does not exist, with the reason for a screen reader. Never a 0. */
export function NoValue({ why }: { why: string }) {
  return (
    <>
      <span aria-hidden="true" className="font-normal text-muted">
        —
      </span>
      <span className="sr-only">{why}</span>
    </>
  );
}

/** The key of a chart, under it: each platform beside its colour. */
export function PlatformKey({ providers }: { providers: readonly string[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted">
      {providers.map((provider) => (
        <li key={provider}>
          <PlatformName provider={provider} />
        </li>
      ))}
    </ul>
  );
}

/** A small native select for a control inside a section header. */
export function InlineSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="inline-block">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 rounded-sm border border-muted bg-canvas px-2 text-lg text-ink hover:bg-surface-soft focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink md:h-7 md:text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export { Help } from '../ui/Help';
