import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { DotsThree } from '../../lib/icons';

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  /** Irreversible or destructive: shown in the error colour. */
  danger?: boolean;
  disabled?: boolean;
}

export interface RowMenuProps {
  /** Accessible name of the trigger, e.g. "Actions for Acme Official". */
  label: string;
  items: RowMenuItem[];
  className?: string;
}

const MENU_WIDTH = 176;

/**
 * The "…" row menu: an accessible menu button. Arrow keys / Home / End move between items, Enter
 * or Space picks one, Escape closes and returns focus to the trigger, Tab closes. The menu is
 * rendered fixed in a portal so a table's scroll frame can never clip it, and it flips upward near
 * the bottom of the screen. Hand-built because no Radix menu package is installed.
 * Usage: <RowMenu label="Actions for Acme" items={[{ label: 'Disconnect', onSelect, danger: true }]} />
 */
export function RowMenu({ label, items, className }: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Place against the trigger: right-aligned, below it, or above when there is no room.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    const room = window.innerHeight - r.bottom;
    const needed = items.length * 36 + 12;
    setPos(
      room < needed && r.top > room
        ? { bottom: window.innerHeight - r.top + 4, left }
        : { top: r.bottom + 4, left },
    );
  }, [open, items.length]);

  // Focus the first enabled item once the menu has a position.
  useEffect(() => {
    if (open && pos)
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) close(false);
    };
    const onMove = () => close(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, close]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const els = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    const i = els.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      els[(n + els.length) % els.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(els.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') close(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          'grid h-11 w-11 flex-none place-items-center rounded-sm text-muted hover:bg-surface-strong hover:text-ink md:h-7 md:w-7',
          open && 'bg-surface-strong text-ink',
          className,
        )}
      >
        <DotsThree size={20} weight="bold" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKey}
            style={{
              position: 'fixed',
              width: MENU_WIDTH,
              visibility: pos ? 'visible' : 'hidden',
              ...pos,
            }}
            className="z-50 rounded-md border border-hairline bg-canvas p-1 shadow-1"
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={it.disabled}
                onClick={() => {
                  close(true);
                  it.onSelect();
                }}
                className={cn(
                  'flex h-11 w-full items-center gap-2 rounded-sm px-2.5 text-left text-base hover:bg-surface-strong focus:bg-surface-strong focus:outline-none disabled:opacity-50 md:h-8 md:text-sm',
                  it.danger ? 'text-error' : 'text-ink',
                )}
              >
                {it.icon}
                {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
