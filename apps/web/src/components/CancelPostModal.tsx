import { useCallback, useRef, useState } from 'react';
import type { PostView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { plural } from '../lib/composer';
import { captionSnippet } from '../lib/postList';
import { partialFailureText, runOnPosts } from '../lib/postOps';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';

/**
 * Confirm cancelling the draft or scheduled variants of a post. Cancelling is final (a cancelled
 * post can't be edited or rescheduled), so the confirm button is the destructive variant. API
 * errors, such as a variant having been sent in the meantime, show in the dialog; the variants that
 * were cancelled are reported through `onApplied` even then. `onClose` must be stable.
 *
 * Usage: {cancelling && <CancelPostModal posts={cancelling} accountName={name} onApplied={apply} onDone={close} onClose={close} />}
 */
export function CancelPostModal({
  posts,
  accountName,
  onApplied,
  onDone,
  onClose,
}: {
  /** The cancelable variants of one group. At least one. */
  posts: PostView[];
  accountName: (post: PostView) => string;
  onApplied: (posts: PostView[]) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a partial failure only what is still cancelable is tried again.
  const [remaining, setRemaining] = useState(posts);

  // Escape and the backdrop must not dismiss mid-request. A ref keeps the handler's identity
  // stable: Modal re-runs its focus handling whenever `onClose` changes.
  const inFlight = useRef(false);
  const guardedClose = useCallback(() => {
    if (!inFlight.current) onClose();
  }, [onClose]);

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await runOnPosts(remaining, async (p) => {
      await api.cancelPost(p.id);
      return { ...p, status: 'cancelled' as const };
    });
    if (result.done.length > 0) onApplied(result.done);
    if (result.failed.length === 0) {
      onDone();
      return;
    }
    setError(partialFailureText(result, 'cancelled', accountName));
    setRemaining(result.failed.map((f) => f.post));
    inFlight.current = false;
    setBusy(false);
  };

  return (
    <Modal title="Cancel this post?" onClose={guardedClose}>
      <p className="text-sm text-body-ink">“{captionSnippet(posts[0]?.caption ?? '', 120)}”</p>
      <p className="mt-3 text-sm text-muted">
        It won’t be published
        {remaining.length > 1 ? ` to ${plural(remaining.length, 'account')}` : ''}, and a cancelled
        post can’t be edited or rescheduled.
      </p>
      {remaining.length > 1 && (
        <ul className="mt-2 list-disc pl-5 text-sm text-body-ink">
          {remaining.map((p) => (
            <li key={p.id}>{accountName(p)}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Keep post
        </Button>
        <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
          {busy ? 'Cancelling…' : 'Cancel post'}
        </Button>
      </div>
    </Modal>
  );
}
