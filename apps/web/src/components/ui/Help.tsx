import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Definition available on keyboard focus, hover and tap, with Escape dismissal. */
export function Help({ label, text }: { label: string; text: string }) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const show = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect)
      setAt({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 264)),
        top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 180)),
      });
  };
  return (
    <span className="inline-flex" onMouseEnter={show} onMouseLeave={() => setAt(null)}>
      <button
        ref={anchor}
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={at !== null}
        aria-describedby={at ? id : undefined}
        onFocus={show}
        onBlur={() => setAt(null)}
        onClick={show}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setAt(null);
          }
        }}
        className="inline-flex h-11 w-11 items-center justify-center rounded-sm text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink md:h-7 md:w-7"
      >
        ⓘ
      </button>
      {at &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            style={{ position: 'fixed', ...at }}
            className="z-50 w-64 max-w-[calc(100vw-16px)] rounded-sm border border-hairline bg-canvas p-3 text-caption text-ink"
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
