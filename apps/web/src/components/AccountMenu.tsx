import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { moveIndex } from '../lib/sidebar';
import { CaretUpDown, LockKey, SignOut } from '../lib/icons';
import { Popover } from './ui/Popover';
import { Tooltip } from './ui/Tooltip';

const itemClass =
  'flex h-11 w-full items-center gap-2 rounded-sm px-2.5 text-left text-base text-ink transition-colors hover:bg-surface-strong focus:bg-surface-strong focus:outline-none active:bg-hairline md:h-8 md:text-sm';

/**
 * The account row at the foot of the sidebar and the menu it opens: who is signed in (name and
 * email in full), Change password, Sign out. Opens upward in a portal, so the sidebar's own scroll
 * frame can never clip it. Keys: Down on the row or Enter opens; Up/Down/Home/End move; Escape closes.
 * Usage: <AccountMenu onNavigate={closeDrawer} collapsed={false} />
 */
export function AccountMenu({
  onNavigate,
  collapsed = false,
  disabled = false,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
  disabled?: boolean;
}) {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const displayName = me?.user.name ?? me?.user.email ?? 'Account';
  const email = me?.user.email ?? '';
  const initial = displayName.trim()[0]?.toUpperCase() ?? 'U';

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  const items = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
  const onKey = (e: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const els = items();
    const at = els.indexOf(document.activeElement as HTMLElement);
    els[moveIndex(at, e.key, els.length)]?.focus();
  };

  return (
    <>
      <Tooltip
        label={
          collapsed
            ? `${displayName}${email && email !== displayName ? ` · ${email}` : ''}`
            : undefined
        }
      >
        <button
          ref={triggerRef}
          type="button"
          aria-label={`Account: ${displayName}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && !open) {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className={cn(
            'flex h-11 w-full items-center rounded-sm text-left transition-colors hover:bg-surface-soft active:bg-surface-strong aria-expanded:bg-surface-strong',
            collapsed ? 'justify-center' : 'gap-2 px-1',
          )}
        >
          <span
            className="grid h-7 w-7 flex-none place-items-center rounded-full bg-surface-strong text-xs font-semibold text-ink"
            aria-hidden="true"
          >
            {initial}
          </span>
          {!collapsed && (
            // The name has the row to itself; the caret sits on the email line, which truncates anyway.
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium text-ink">{displayName}</span>
              <span className="flex items-center gap-1 text-micro text-muted">
                <span className="min-w-0 flex-1 truncate">{me?.user.name ? email : 'Account'}</span>
                <CaretUpDown size={10} className="flex-none" aria-hidden="true" />
              </span>
            </span>
          )}
        </button>
      </Tooltip>

      {open && (
        <Popover
          anchorRef={triggerRef}
          onClose={close}
          prefer="above"
          role="menu"
          label={`Account: ${displayName}`}
          minWidth={288}
          maxWidth={360}
          onKeyDown={onKey}
          onPlaced={() => items()[0]?.focus()}
        >
          <div ref={menuRef} className="flex min-h-0 flex-col overflow-y-auto">
            <div role="none" className="min-w-0 px-2.5 pb-2 pt-1.5">
              <p className="break-words text-sm font-medium text-ink">{displayName}</p>
              {me?.user.name && <p className="break-all text-xs text-muted">{email}</p>}
            </div>
            <div role="separator" className="mb-1 border-t border-hairline-soft" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={itemClass}
              onClick={() => {
                close(false);
                onNavigate?.();
                navigate('/settings/password');
              }}
            >
              <LockKey size={14} aria-hidden="true" />
              Change password
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={itemClass}
              onClick={() => {
                close(false);
                void logout().then(() => navigate('/login'));
              }}
            >
              <SignOut size={14} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}
