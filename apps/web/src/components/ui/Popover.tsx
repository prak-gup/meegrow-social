import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { placePopover, type Placement } from '../../lib/sidebar';

export interface PopoverProps {
  anchorRef: RefObject<HTMLElement>;
  /** Called on Escape, Tab, an outside click or when the trigger scrolls out of reach. */
  onClose: (restoreFocus: boolean) => void;
  prefer?: 'below' | 'above';
  minWidth?: number;
  maxWidth?: number;
  /** ARIA role of the surface (`menu`, `dialog`, …) and its accessible name. */
  role?: string;
  label: string;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** Called once the popover is placed, e.g. to move focus into it. */
  onPlaced?: (el: HTMLDivElement) => void;
  className?: string;
  children: ReactNode;
}

/**
 * A floating panel that cannot be clipped: it renders fixed in a portal (into the open modal, if
 * the trigger is inside one, so a mobile drawer's focus handling and screen-reader scope stay
 * intact), placed from the trigger's box — left edges aligned, shifted to stay inside the viewport,
 * flipped to the roomier side, height capped so its own list scrolls. It never touches the layout
 * of the sidebar it opens from. The surface is a flex column: give a long list `min-h-0
 * overflow-y-auto` and it takes the leftover height.
 * Usage: {open && <Popover anchorRef={btn} onClose={close} label="Switch client">…</Popover>}
 */
export function Popover({
  anchorRef,
  onClose,
  prefer = 'below',
  minWidth = 260,
  maxWidth = 340,
  role,
  label,
  onKeyDown,
  onPlaced,
  className,
  children,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const natural = useRef(0);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      onClose(false); // the trigger is gone or hidden (e.g. the viewport crossed a breakpoint)
      return;
    }
    setPlacement(
      placePopover({
        anchor: r,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        contentHeight: natural.current,
        prefer,
        minWidth,
        maxWidth,
      }),
    );
  }, [anchorRef, onClose, prefer, minWidth, maxWidth]);

  // Measure the unconstrained height once, then place. Runs before paint, so there is no flash.
  useLayoutEffect(() => {
    natural.current = ref.current?.getBoundingClientRect().height ?? 0;
    place();
  }, []);

  useEffect(() => {
    if (placement && ref.current) onPlaced?.(ref.current);
  }, [placement === null]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchorRef.current?.contains(t)) onClose(false);
    };
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) place();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchorRef, onClose, place]);

  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Escape is ours alone: stopping it here keeps an open drawer or modal from closing too.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    // Tab leaves the popover from the trigger, so focus carries on in page order.
    if (e.key === 'Tab') {
      onClose(true);
      return;
    }
    onKeyDown?.(e);
  };

  const host = anchorRef.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body;

  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      data-popover=""
      onKeyDown={handleKey}
      style={{
        position: 'fixed',
        left: placement?.left ?? 0,
        top: placement?.top,
        bottom: placement?.bottom,
        width: placement?.width ?? minWidth,
        maxHeight: placement?.maxHeight,
        visibility: placement ? 'visible' : 'hidden',
      }}
      className={cn(
        'z-50 flex flex-col overflow-hidden rounded-md border border-hairline bg-canvas p-1.5 shadow-1',
        className,
      )}
    >
      {children}
    </div>,
    host,
  );
}
