import { Fragment, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { ArrowDown, ArrowUp } from '../../lib/icons';
import { Help } from './Help';
import { EmptyState, type EmptyStateProps } from './EmptyState';

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  help?: string;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /** Extra classes for both header and cells, e.g. `hidden md:table-cell` to drop it on phones. */
  className?: string;
  /** Makes the header a sort button: the key handed to `onSort` (needs `onSort` on the table). */
  sortKey?: string;
}

export interface TableSort {
  key: string;
  dir: 'asc' | 'desc';
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** Rendered in a trailing column; use for buttons/menus. */
  rowActions?: (row: T) => ReactNode;
  /** Shown instead of the table when `rows` is empty. */
  empty?: EmptyStateProps;
  /** Accessible name for the table. */
  caption?: string;
  /** Tighter rows (`py-1.5`) for data-heavy tables. */
  dense?: boolean;
  /** Keep the header in view: the frame becomes a scroll area no taller than the screen. */
  stickyHeader?: boolean;
  /** Makes the whole row clickable. Pair it with a real button in a cell for keyboard users. */
  onRowClick?: (row: T) => void;
  /** Detail shown in a full-width row under `row`; return null/undefined for a collapsed row. */
  renderExpanded?: (row: T) => ReactNode;
  /** The column the rows are ordered by, marked in its header. The caller does the ordering. */
  sort?: TableSort;
  /** A sortable header was pressed. */
  onSort?: (key: string) => void;
  className?: string;
}

/** Dense, hairline table. Scrolls horizontally inside its frame rather than breaking the page. */
export function Table<T>({
  columns,
  rows,
  rowKey,
  rowActions,
  empty,
  caption,
  dense = false,
  stickyHeader = false,
  onRowClick,
  renderExpanded,
  sort,
  onSort,
  className,
}: TableProps<T>) {
  if (rows.length === 0 && empty) return <EmptyState {...empty} className={className} />;
  const pad = dense ? 'px-3 py-1.5' : 'px-3 py-2';
  const headPad = 'px-3 py-2';
  const sticky = stickyHeader && 'sticky top-0 z-10 bg-surface-soft';
  const span = columns.length + (rowActions ? 1 : 0);
  return (
    <div
      className={cn(
        // `relative`: screen-reader-only text in a cell is absolutely positioned, and only a
        // positioned scroll frame clips it — otherwise a wide table widens the whole page.
        'relative rounded-md border border-hairline bg-canvas',
        stickyHeader ? 'max-h-screen overflow-auto' : 'overflow-x-auto',
        className,
      )}
    >
      <table className="w-full border-collapse text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-surface-soft">
          <tr>
            {columns.map((c) => {
              const sortable = c.sortKey !== undefined && onSort !== undefined;
              const sorted = sortable && sort && sort.key === c.sortKey ? sort.dir : null;
              const SortIcon = sorted === 'asc' ? ArrowUp : ArrowDown;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={
                    !sortable
                      ? undefined
                      : sorted === 'asc'
                        ? 'ascending'
                        : sorted === 'desc'
                          ? 'descending'
                          : 'none'
                  }
                  className={cn(
                    headPad,
                    sticky,
                    'text-caption font-medium text-muted',
                    c.align === 'right' && 'text-right',
                    c.className,
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort(c.sortKey!)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-xs hover:text-ink',
                        sorted && 'font-semibold text-ink',
                      )}
                    >
                      {c.header}
                      {/* The arrow is the visible half of `aria-sort`; unsorted columns keep its room. */}
                      <SortIcon
                        size={10}
                        weight="bold"
                        aria-hidden="true"
                        className={cn('flex-none', !sorted && 'invisible')}
                      />
                    </button>
                  ) : (
                    c.header
                  )}
                  {c.help && (
                    <Help label={typeof c.header === 'string' ? c.header : c.key} text={c.help} />
                  )}
                </th>
              );
            })}
            {rowActions && (
              <th scope="col" className={cn(headPad, sticky)}>
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const expanded = renderExpanded?.(row);
            return (
              <Fragment key={rowKey(row, index)}>
                <tr
                  onClick={onRowClick && (() => onRowClick(row))}
                  className={cn(
                    'border-t border-hairline-soft align-middle hover:bg-surface-soft',
                    onRowClick && 'cursor-pointer',
                  )}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        pad,
                        'text-ink',
                        c.align === 'right' && 'tnum text-right',
                        c.className,
                      )}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                  {rowActions && (
                    // A `w-full` column elsewhere squeezes this one to its narrowest content, which
                    // for a two-word button is one word per line. Actions never wrap.
                    <td className={cn(pad, 'whitespace-nowrap')}>
                      <div className="flex items-center justify-end gap-1.5">{rowActions(row)}</div>
                    </td>
                  )}
                </tr>
                {expanded != null && expanded !== false && (
                  <tr className="bg-surface-soft">
                    <td colSpan={span} className={pad}>
                      {expanded}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
