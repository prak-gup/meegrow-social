import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TooltipProps {
  /** What to say. Empty or undefined shows nothing. */
  label?: string;
  /** Which side of the control it appears on. Default `right`, for a left rail. */
  side?: 'right' | 'below';
  /**
   * Show only when this returns true for the wrapper, e.g. when its text is truncated. Checked
   * each time the pointer or focus arrives.
   */
  when?: (el: HTMLElement) => boolean;
  children: ReactNode;
}

/**
 * A small hover/focus label, drawn in a portal so a scrolling sidebar can never clip it. It only
 * repeats a name that the control already carries (`aria-label`), so it is hidden from assistive
 * tech. Dismissed by Escape, a click or leaving. Wraps its child in a block, so use it on rows.
 * Usage: <Tooltip label="Overview" side="right"><NavLink aria-label="Overview" …/></Tooltip>
 */
export function Tooltip({ label, side = 'right', when, children }: TooltipProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const timer = useRef<number>();
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  const hide = () => {
    window.clearTimeout(timer.current);
    setAt(null);
  };
  const show = (delay: number) => {
    window.clearTimeout(timer.current);
    const el = wrap.current;
    if (!label || !el || (when && !when(el))) return;
    timer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      setAt(
        side === 'right'
          ? { left: r.right + 8, top: r.top + r.height / 2 }
          : { left: r.left, top: r.bottom + 6 },
      );
    }, delay);
  };

  useEffect(() => hide, []);
  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [at]);

  return (
    <div
      ref={wrap}
      onMouseEnter={() => show(350)}
      onMouseLeave={hide}
      onMouseDown={hide}
      onFocus={(e) => e.target.matches(':focus-visible') && show(0)}
      onBlur={hide}
    >
      {children}
      {at &&
        label &&
        createPortal(
          <div
            aria-hidden="true"
            style={{
              position: 'fixed',
              left: at.left,
              top: at.top,
              transform: side === 'right' ? 'translateY(-50%)' : undefined,
            }}
            className="pointer-events-none z-50 max-w-xs rounded-sm bg-ink px-2 py-1 text-xs font-medium text-white shadow-1"
          >
            {label}
          </div>,
          document.body,
        )}
    </div>
  );
}
