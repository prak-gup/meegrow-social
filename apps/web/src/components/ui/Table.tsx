import type { ReactNode } from 'react';
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
  className,
}: TableProps<T>) {
  if (rows.length === 0 && empty) return <EmptyState {...empty} className={className} />;
  return (
    <div className={cn('overflow-x-auto rounded-md border border-hairline bg-canvas', className)}>
      <table className="w-full border-collapse text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-surface-soft">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  'px-4 py-2.5 text-caption font-bold text-muted',
                  c.align === 'right' && 'text-right',
                  c.className,
                )}
              >
                {c.header}
              </th>
            ))}
            {rowActions && (
              <th scope="col" className="px-4 py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              className="border-t border-hairline-soft align-middle hover:bg-surface-soft"
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'px-4 py-3 text-ink',
                    c.align === 'right' && 'tnum text-right',
                    c.className,
                  )}
                >
                  {c.cell(row)}
                </td>
              ))}
              {rowActions && (
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">{rowActions(row)}</div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
