import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from '../../lib/icons';

/**
 * Minimal accessible modal: overlay + click-outside, Escape-to-close, initial focus into the
 * dialog, and focus restored to the trigger on close. Hand-rolled to avoid a Dialog dependency.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Move focus into the dialog (its first focusable, else the dialog itself).
    const focusable = dialogRef.current?.querySelector<HTMLElement>(
      'input, textarea, button, [href], select, [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? dialogRef.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-scrim/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-lg border border-hairline bg-canvas p-4 shadow-1 md:p-5 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-lg font-semibold md:text-base">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 grid h-11 w-11 flex-none place-items-center rounded-sm text-muted hover:bg-surface-strong hover:text-ink md:h-8 md:w-8"
            aria-label="Close"
          >
            <CloseIcon size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
