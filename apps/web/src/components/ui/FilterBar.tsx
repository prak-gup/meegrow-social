import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { CaretDown, MagnifyingGlass } from '../../lib/icons';

export interface FilterBarProps {
  /** Search box at the left; omit when the list has nothing worth searching. */
  search?: { value: string; onChange: (v: string) => void; placeholder: string; label: string };
  /** <FilterSelect> pills, in the order they should read. */
  filters?: ReactNode;
  /** Right-aligned: a <ViewToggle>, a count, buttons. */
  actions?: ReactNode;
  className?: string;
}

/**
 * One line of list controls: search on the left, compact pill filters, view toggles/actions on the
 * right. It wraps instead of overflowing, and the search takes the full row on a phone.
 * Usage: <FilterBar search={{...}} filters={<FilterSelect .../>} actions={<ViewToggle .../>} />
 */
export function FilterBar({ search, filters, actions, className }: FilterBarProps) {
  return (
    <div
      role="search"
      className={cn('mb-3 flex flex-wrap items-center gap-x-2 gap-y-2', className)}
    >
      {search && (
        <label className="relative block w-full sm:w-60">
          <span className="sr-only">{search.label}</span>
          <MagnifyingGlass
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder}
            className="h-11 w-full rounded-full border border-muted-soft bg-canvas pl-8 pr-3 text-lg text-ink placeholder:text-muted focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink md:h-8 md:text-sm"
          />
        </label>
      )}
      {filters}
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export interface FilterSelectProps {
  /** Accessible name, e.g. "Status". Not drawn: the selected option reads as the pill's text. */
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** The first option is the "no filter" choice, e.g. { value: '', label: 'All statuses' }. */
  options: { value: string; label: string }[];
}

/** A compact pill dropdown (native <select>, so keyboard and screen readers just work). */
export function FilterSelect({ label, value, onChange, options }: FilterSelectProps) {
  const active = value !== options[0]?.value;
  return (
    <label className="relative inline-block">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-11 appearance-none rounded-full border bg-canvas pl-3 pr-7 text-lg text-ink hover:bg-surface-soft focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink md:h-8 md:text-sm',
          active ? 'border-ink bg-surface-strong font-medium' : 'border-muted-soft',
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <CaretDown
        size={12}
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted"
      />
    </label>
  );
}

export interface ViewToggleProps {
  /** Accessible name of the group, e.g. "View". */
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; icon: ReactNode }[];
}

/** A segmented icon toggle. Each segment is a pressed/unpressed button with a text name. */
export function ViewToggle({ label, value, onChange, options }: ViewToggleProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-sm border border-muted-soft p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          aria-label={o.label}
          title={o.label}
          onClick={() => onChange(o.value)}
          className={cn(
            'grid h-10 w-10 place-items-center rounded-xs text-muted hover:text-ink md:h-6 md:w-7',
            o.value === value && 'bg-surface-strong text-ink',
          )}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
