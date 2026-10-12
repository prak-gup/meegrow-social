import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { OverviewView } from '@meegrow-social/contracts';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import {
  formatBadge,
  isComposeShortcut,
  navBadges,
  readCollapsed,
  writeCollapsed,
} from '../lib/sidebar';
import { useSidebarOverview } from '../lib/useSidebarOverview';
import { Composer } from '../pages/Composer';
import { AccountMenu } from './AccountMenu';
import { ClientSwitcher } from './ClientSwitcher';
import { AddClientModal } from './AddClientModal';
import { Logo } from './Logo';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import {
  House,
  Article,
  CalendarBlank,
  SquaresFour,
  ChartLineUp,
  UsersThree,
  Plugs,
  Key,
  Plus,
  List,
  CloseIcon,
  SidebarSimple,
  type IconComponent,
} from '../lib/icons';

type BadgeKey = 'content' | 'connections';

const TABS: { to: string; label: string; Icon: IconComponent; badge?: BadgeKey }[] = [
  { to: '/overview', label: 'Overview', Icon: House },
  { to: '/calendar', label: 'Calendar', Icon: CalendarBlank },
  { to: '/content', label: 'Content', Icon: SquaresFour, badge: 'content' },
  { to: '/blog', label: 'Blog', Icon: Article },
  // Always listed. Until the numbers are validated against the platforms the page itself carries a
  // "Preview" badge (VITE_ANALYTICS_UI, see pages/Analytics.tsx and docs/dev/ANALYTICS-UI-BRIEF.md §1).
  { to: '/analytics', label: 'Analytics', Icon: ChartLineUp },
  { to: '/clients', label: 'Clients', Icon: UsersThree },
  { to: '/connections', label: 'Connections', Icon: Plugs, badge: 'connections' },
  { to: '/settings/api-keys', label: 'API keys', Icon: Key },
];

/** What a nav badge counts, in words (the number alone is not a name). */
const BADGE_WORDS: Record<BadgeKey, (n: number) => string> = {
  content: (n) => (n === 1 ? 'failed post' : 'failed posts'),
  connections: () => 'need attention',
};

interface SidebarProps {
  onNavigate?: () => void;
  onAddClient: () => void;
  overview: OverviewView | null;
  onSwitcherOpen: () => void;
  /** Icon-rail form (desktop only). */
  collapsed?: boolean;
  /** Present on the desktop rail only: flips collapsed/expanded. */
  onToggleCollapsed?: () => void;
  /** The composer is open: the sidebar is inert, so no popover may be open or openable. */
  composing: boolean;
}

/** Everything the sidebar holds. Rendered once as the desktop rail and once inside the mobile drawer. */
function SidebarContent({
  onNavigate,
  onAddClient,
  overview,
  onSwitcherOpen,
  collapsed = false,
  onToggleCollapsed,
  composing,
}: SidebarProps) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const badges = navBadges(overview);
  const tabs = TABS.filter((tab) => tab.to !== '/blog' || me?.activeWorkspaceId);

  return (
    <div className={cn('flex h-full flex-col gap-3', collapsed ? 'p-2' : 'p-3')}>
      <Logo
        className={cn('py-1', collapsed ? 'justify-center' : 'pl-1 pr-10 md:pr-1')}
        size={24}
        compact={collapsed}
      />

      {/* No lock needed while composing: the composer is a modal panel and this whole sidebar is
          inert behind it, so the client cannot change under an unsaved post. */}
      <ClientSwitcher
        onAddClient={onAddClient}
        onNavigate={onNavigate}
        overview={overview}
        onOpen={onSwitcherOpen}
        collapsed={collapsed}
        disabled={composing}
      />

      <Tooltip label={collapsed ? 'Create post (C)' : undefined}>
        <Button
          variant="accent"
          size={collapsed ? 'icon' : 'default'}
          className={cn('relative w-full active:bg-rausch-active', collapsed && 'md:w-full')}
          aria-label="Create post"
          aria-keyshortcuts="c"
          disabled={composing}
          onClick={() => {
            onNavigate?.();
            // The composer opens as a panel over this page and returns here when closed.
            navigate('/composer', { state: { background: pathname + search } });
          }}
        >
          <Plus size={16} weight="bold" aria-hidden="true" />
          {!collapsed && (
            <>
              Create post
              <kbd className="absolute right-2 hidden rounded-xs bg-white/20 px-1 font-sans text-micro font-medium md:inline">
                C
              </kbd>
            </>
          )}
        </Button>
      </Tooltip>

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {tabs.map(({ to, label, Icon, badge }) => {
          const n = badge ? badges[badge] : 0;
          const words = n > 0 && badge ? `${formatBadge(n)} ${BADGE_WORDS[badge](n)}` : '';
          return (
            <Tooltip
              key={to}
              label={collapsed ? (words ? `${label} · ${words}` : label) : undefined}
            >
              <NavLink
                to={to}
                onClick={onNavigate}
                aria-label={collapsed ? (words ? `${label}, ${words}` : label) : undefined}
                className={({ isActive }) => navClass(isActive, collapsed)}
              >
                {({ isActive }) => (
                  <>
                    <span className="relative flex-none">
                      <Icon size={18} weight={isActive ? 'fill' : 'regular'} aria-hidden="true" />
                      {collapsed && n > 0 && (
                        <span
                          aria-hidden="true"
                          className={cn(
                            'absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-canvas',
                            badge === 'content' ? 'bg-status-bad' : 'bg-status-warn',
                          )}
                        />
                      )}
                    </span>
                    {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
                    {!collapsed && n > 0 && (
                      <span
                        className={cn(
                          'tnum grid h-4 min-w-4 flex-none place-items-center rounded-full px-1 text-micro font-semibold text-white',
                          badge === 'content' ? 'bg-status-bad' : 'bg-status-warn',
                        )}
                      >
                        <span aria-hidden="true">{formatBadge(n)}</span>
                        <span className="sr-only">{words}</span>
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            </Tooltip>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-1 border-t border-hairline-soft pt-2">
        {onToggleCollapsed && (
          <Tooltip label={collapsed ? 'Expand sidebar' : undefined}>
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={cn(
                'flex h-8 w-full items-center rounded-sm text-sm font-medium text-muted transition-colors hover:bg-surface-soft hover:text-ink active:bg-surface-strong',
                collapsed ? 'justify-center' : 'gap-2.5 px-2.5',
              )}
            >
              <SidebarSimple size={18} aria-hidden="true" />
              {!collapsed && 'Collapse'}
            </button>
          </Tooltip>
        )}
        {/* Account-level actions live in one menu on the user row, so the name gets the row's full
            width instead of sharing it with icons. */}
        <AccountMenu onNavigate={onNavigate} collapsed={collapsed} disabled={composing} />
      </div>
    </div>
  );
}

/**
 * A sidebar row: 44px on a phone drawer, 32px from md up. Hover, pressed and keyboard-focus each
 * read differently. The active page is a stronger fill, a slim ink bar on the left edge, a filled
 * icon and `aria-current="page"` (NavLink sets it) — never the accent colour.
 */
const navClass = (isActive: boolean, collapsed: boolean) =>
  cn(
    'relative flex h-11 items-center rounded-sm text-base font-medium transition-colors md:h-8',
    collapsed ? 'justify-center' : 'gap-2 px-2.5',
    isActive
      ? 'bg-surface-strong text-ink before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-ink'
      : 'text-muted hover:bg-surface-soft hover:text-ink active:bg-surface-strong',
  );

/**
 * Work-tool shell: fixed left sidebar (brand · client switcher · create · nav · account) on md+,
 * a top bar + slide-in drawer below that. Content is full width; pages own their header via
 * <PageHeader>.
 */
export function AppLayout({
  composerOver = null,
}: {
  /**
   * Set while the address is /composer: the page the composer panel sits over, which is also what
   * `useLocation()` reports in here (App.tsx matches the routes against it).
   */
  composerOver?: string | null;
}) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const composing = composerOver !== null;
  const [adding, setAdding] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const { overview, refresh, refreshIfStale } = useSidebarOverview(me?.activeWorkspaceId ?? null);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      writeCollapsed(!v);
      return !v;
    });
  }, []);

  // Numbers on the nav go stale as posts fail and connections lapse: re-check when the user moves.
  useEffect(() => refreshIfStale(), [pathname, refreshIfStale]);

  // `c` opens the composer, unless the user is typing or something modal is already open.
  useEffect(() => {
    if (composing || drawer || adding) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isComposeShortcut(e)) return;
      if (document.querySelector('[role="dialog"], [data-popover]')) return;
      e.preventDefault();
      navigate('/composer', { state: { background: pathname + search } });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [composing, drawer, adding, navigate, pathname, search]);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const backgroundRef = useRef<HTMLDivElement>(null);

  // Close the drawer on any navigation.
  useEffect(() => setDrawer(false), [pathname]);

  // Modal behaviour while the drawer is open: focus moves in and is trapped, Escape closes,
  // the page behind is inert + aria-hidden, and focus returns to the menu button on close.
  useEffect(() => {
    if (!drawer) return;
    const trigger = triggerRef.current;
    const bg = backgroundRef.current;
    bg?.setAttribute('inert', '');
    bg?.setAttribute('aria-hidden', 'true');
    const focusables = () =>
      Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawer(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const current = document.activeElement;
      if (!drawerRef.current?.contains(current)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      bg?.removeAttribute('inert');
      bg?.removeAttribute('aria-hidden');
      trigger?.focus();
    };
  }, [drawer]);

  // The composer panel is a modal dialog: everything behind it is inert while it is open. Declared
  // after the drawer's effect and re-run with it, so a closing drawer cannot switch this back off.
  useEffect(() => {
    if (!composing) return;
    const bg = backgroundRef.current;
    bg?.setAttribute('inert', '');
    return () => bg?.removeAttribute('inert');
  }, [composing, drawer]);

  return (
    <div className={cn('min-h-screen bg-canvas', collapsed ? 'md:pl-14' : 'md:pl-sidebar')}>
      <div ref={backgroundRef}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-ink focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
        >
          Skip to content
        </a>
        {/* Desktop rail. overflow-x is hidden outright: a popover can never widen or scroll it. */}
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-30 hidden overflow-y-auto overflow-x-hidden border-r border-hairline bg-canvas md:block',
            collapsed ? 'w-14' : 'w-sidebar',
          )}
        >
          <SidebarContent
            onAddClient={() => setAdding(true)}
            overview={overview}
            onSwitcherOpen={() => void refresh()}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            composing={composing}
          />
        </aside>

        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-hairline bg-canvas px-4 md:hidden">
          <button
            type="button"
            ref={triggerRef}
            onClick={() => setDrawer(true)}
            className="-ml-2 grid h-11 w-11 place-items-center rounded-sm hover:bg-surface-soft"
            aria-label="Open menu"
            aria-expanded={drawer}
          >
            <List size={22} />
          </button>
          <Logo size={24} />
          <NavLink
            to="/composer"
            state={{ background: pathname + search }}
            className="-mr-2 grid h-11 w-11 place-items-center rounded-sm bg-rausch text-white hover:bg-rausch-active"
            aria-label="Create post"
          >
            <Plus size={18} weight="bold" />
          </NavLink>
        </header>

        {/* Keyed on the active workspace so workspace-scoped pages (Content/Connections) remount and
          refetch when the client switcher changes scope — otherwise a same-route switch is a no-op
          and the page keeps showing the previous client's data. */}
        <main
          id="main-content"
          tabIndex={-1}
          key={me?.activeWorkspaceId ?? 'none'}
          className="px-4 py-4 focus:outline-none md:px-6 md:py-5"
        >
          <Outlet />
        </main>
      </div>

      {/* Mobile drawer */}
      {drawer && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Main menu"
        >
          <button
            type="button"
            className="absolute inset-0 bg-scrim/40"
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
          />
          <aside
            ref={drawerRef}
            className="absolute inset-y-0 left-0 w-64 max-w-[85vw] overflow-y-auto overflow-x-hidden bg-canvas shadow-1"
          >
            <button
              type="button"
              onClick={() => setDrawer(false)}
              className="absolute right-1 top-1 grid h-11 w-11 place-items-center rounded-sm text-muted hover:bg-surface-soft"
              aria-label="Close menu"
            >
              <CloseIcon size={18} />
            </button>
            <SidebarContent
              overview={overview}
              onSwitcherOpen={() => void refresh()}
              composing={composing}
              onNavigate={() => setDrawer(false)}
              onAddClient={() => {
                setDrawer(false);
                setAdding(true);
              }}
            />
          </aside>
        </div>
      )}

      {/* Keyed like <main>: a change of client starts a fresh post rather than carrying one over. */}
      {composerOver !== null && (
        <Composer key={me?.activeWorkspaceId ?? 'none'} background={composerOver} />
      )}

      {adding && <AddClientModal onClose={() => setAdding(false)} />}
    </div>
  );
}
