import { useCallback, useRef, useState } from 'react';
import type { PostView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { captionSnippet } from '../lib/postList';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';

/**
 * Confirm cancelling a draft or scheduled post. Cancelling is final (a cancelled post can't be
 * edited or rescheduled), so the confirm button is the destructive variant. API errors, such as the
 * post having been sent in the meantime, show in the dialog. `onClose` must be stable.
 *
 * Usage: {cancelling && <CancelPostModal post={cancelling} onCancelled={mark} onClose={close} />}
 */
export function CancelPostModal({
  post,
  onCancelled,
  onClose,
}: {
  post: PostView;
  onCancelled: (post: PostView) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    try {
      await api.cancelPost(post.id);
      onCancelled(post);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel the post. Try again.');
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal title="Cancel this post?" onClose={guardedClose}>
      <p className="text-sm text-body-ink">“{captionSnippet(post.caption, 120)}”</p>
      <p className="mt-3 text-sm text-muted">
        It won’t be published, and a cancelled post can’t be edited or rescheduled.
      </p>
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
