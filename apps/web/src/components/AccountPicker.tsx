import { useEffect, useRef, useState } from 'react';
import type { ConnectionView } from '@meegrow-social/contracts';
import { cn } from '../lib/cn';
import {
  groupAccounts,
  groupSelection,
  matchAccounts,
  setGroupSelected,
  type AccountWarning,
} from '../lib/composer';
import { Check, MagnifyingGlass, WarningCircle } from '../lib/icons';
import { platformMeta } from '../lib/platforms';
import { PlatformBadge } from './ui/PlatformBadge';

/** A search box earns its row once the list is longer than a glance. */
const SEARCH_FROM = 7;

const platformLabel = (provider: string) =>
  platformMeta({ identifier: provider, displayName: provider }).label;

/** The square of a checkbox, drawn: the real <input> is visually hidden beside it. */
function Box({ state }: { state: 'all' | 'some' | 'none' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid h-4 w-4 flex-none place-items-center rounded-xs border',
        state === 'none' ? 'border-hairline-strong bg-canvas' : 'border-ink bg-ink text-white',
      )}
    >
      {state === 'all' && <Check size={10} weight="bold" />}
      {state === 'some' && <span className="h-0.5 w-2 rounded-full bg-white" />}
    </span>
  );
}

const focusRing =
  'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink';

/** "Select all" for one platform. Mixed when only some of its accounts are picked. */
function GroupCheckbox({
  label,
  state,
  onChange,
}: {
  label: string;
  state: 'all' | 'some' | 'none';
  onChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // `indeterminate` exists only as a DOM property; it is what makes a screen reader say "mixed".
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <label className="relative -m-2 flex cursor-pointer p-2">
      <input
        ref={ref}
        type="checkbox"
        className="peer sr-only"
        aria-label={label}
        checked={state === 'all'}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={cn('rounded-xs', focusRing)}>
        <Box state={state} />
      </span>
    </label>
  );
}

function AccountRow({
  conn,
  selected,
  warning,
  onToggle,
  describedBy,
}: {
  conn: ConnectionView;
  selected: boolean;
  warning: AccountWarning | undefined;
  onToggle: () => void;
  describedBy?: string;
}) {
  const reasonId = `account-warning-${conn.id}`;
  return (
    <label className="relative block min-w-0">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={selected}
        onChange={onToggle}
        aria-describedby={cn(warning && reasonId, describedBy) || undefined}
      />
      <span
        className={cn(
          'flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-sm border bg-canvas px-2 py-1 text-left transition-colors md:min-h-10',
          focusRing,
          selected ? 'border-ink bg-surface-soft' : 'border-hairline hover:bg-surface-soft',
        )}
      >
        <Box state={selected ? 'all' : 'none'} />
        <PlatformBadge provider={conn.provider} name={conn.displayName} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm font-medium text-ink">{conn.displayName}</span>
          {/* The reason is written out, not left to a hover: it is read with the checkbox
              (aria-describedby) and is there for keyboard and touch. */}
          {warning ? (
            <span
              id={reasonId}
              className={cn(
                'mt-1 flex items-start gap-1 rounded-xs bg-surface-soft px-1.5 py-1 text-caption text-error',
              )}
            >
              <WarningCircle size={14} className="mt-0.5 flex-none" aria-hidden="true" />
              {warning.reason}
            </span>
          ) : (
            <span className="truncate text-micro text-muted">{platformLabel(conn.provider)}</span>
          )}
        </span>
      </span>
    </label>
  );
}

export interface AccountPickerProps {
  /** Every account of the active client. */
  connections: ConnectionView[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  /** Why an account should not be posted to as things stand (lib/composer `accountWarnings`). */
  warnings: ReadonlyMap<string, AccountWarning>;
  /** Id of an error message that applies to the whole choice ("Select at least one account."). */
  describedBy?: string;
  className?: string;
}

/**
 * Which accounts a post goes to, built to stay usable at dozens of accounts: a search, accounts
 * grouped under their platform with a count and a select-all, and compact rows. An account that
 * needs reconnecting or cannot take the post as written carries a warning with its reason in words.
 * Usage: <AccountPicker connections={conns} selectedIds={ids} onChange={setIds} warnings={w} />
 */
export function AccountPicker({
  connections,
  selectedIds,
  onChange,
  warnings,
  describedBy,
  className,
}: AccountPickerProps) {
  const [query, setQuery] = useState('');
  const searchable = connections.length >= SEARCH_FROM;
  const shown = searchable ? matchAccounts(connections, query, platformLabel) : connections;
  const groups = groupAccounts(shown);
  const picked = new Set(selectedIds);
  const toggle = (id: string) =>
    onChange(picked.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);

  return (
    <div className={cn('space-y-3', className)}>
      {searchable && (
        <label className="relative block">
          <span className="sr-only">Search accounts</span>
          <MagnifyingGlass
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search accounts…"
            className="h-11 w-full rounded-sm border border-muted-soft bg-canvas pl-8 pr-3 text-lg text-ink placeholder:text-muted focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink md:h-8 md:text-sm"
          />
        </label>
      )}
      {groups.length === 0 && (
        <p className="text-sm text-muted" role="status">
          {query ? `No accounts match “${query}”.` : 'No accounts are available for this mode.'}
        </p>
      )}
      {groups.map(({ provider, accounts }) => {
        const platform = platformMeta({ identifier: provider, displayName: provider });
        const ids = accounts.map((a) => a.id);
        return (
          <fieldset key={provider} className="min-w-0">
            <div className="mb-1.5 flex items-center gap-2">
              <legend className="float-left flex items-center gap-1.5 p-0 text-caption font-medium text-muted">
                <platform.Icon size={14} aria-hidden="true" />
                {platform.label}
                <span className="tnum font-normal">{accounts.length}</span>
              </legend>
              <span className="ml-auto flex items-center gap-2 pr-2">
                <GroupCheckbox
                  label={`Select all ${accounts.length} ${platform.label} accounts`}
                  state={groupSelection(ids, selectedIds)}
                  onChange={(on) => onChange(setGroupSelected(selectedIds, ids, on))}
                />
              </span>
            </div>
            {/* One account a line: the name and a warning's reason are read in full, which two
                narrow columns could not give. */}
            <div className="clear-both grid gap-1">
              {accounts.map((c) => (
                <AccountRow
                  key={c.id}
                  conn={c}
                  selected={picked.has(c.id)}
                  warning={picked.has(c.id) ? warnings.get(c.id) : undefined}
                  onToggle={() => toggle(c.id)}
                  describedBy={describedBy}
                />
              ))}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
