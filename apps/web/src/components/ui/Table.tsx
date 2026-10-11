import { Fragment, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { EmptyState, type EmptyStateProps } from './EmptyState';

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /** Extra classes for both header and cells, e.g. `hidden md:table-cell` to drop it on phones. */
  className?: string;
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
  /** Tighter rows (`py-2`) for data-heavy tables. */
  dense?: boolean;
  /** Keep the header in view: the frame becomes a scroll area no taller than the screen. */
  stickyHeader?: boolean;
  /** Makes the whole row clickable. Pair it with a real button in a cell for keyboard users. */
  onRowClick?: (row: T) => void;
  /** Detail shown in a full-width row under `row`; return null/undefined for a collapsed row. */
  renderExpanded?: (row: T) => ReactNode;
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
  className,
}: TableProps<T>) {
  if (rows.length === 0 && empty) return <EmptyState {...empty} className={className} />;
  const pad = dense ? 'px-3 py-2' : 'px-4 py-3';
  const headPad = dense ? 'px-3 py-2' : 'px-4 py-2.5';
  const sticky = stickyHeader && 'sticky top-0 z-10 bg-surface-soft';
  const span = columns.length + (rowActions ? 1 : 0);
  return (
    <div
      className={cn(
        'rounded-md border border-hairline bg-canvas',
        stickyHeader ? 'max-h-screen overflow-auto' : 'overflow-x-auto',
        className,
      )}
    >
      <table className="w-full border-collapse text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-surface-soft">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  headPad,
                  sticky,
                  'text-caption font-bold text-muted',
                  c.align === 'right' && 'text-right',
                  c.className,
                )}
              >
                {c.header}
              </th>
            ))}
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
                      <div className="flex items-center justify-end gap-2">{rowActions(row)}</div>
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
