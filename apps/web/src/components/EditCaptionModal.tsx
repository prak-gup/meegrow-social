import { useCallback, useEffect, useRef, useState } from 'react';
import type { PostView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { CAPTION_MAX } from '../lib/postList';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Label } from './ui/Label';
import { Textarea } from './ui/Textarea';

/**
 * Edit a post's caption (the API only accepts this for draft/scheduled posts). Failures stay in the
 * dialog so the operator keeps their text. `onClose` must be stable: Modal re-runs its focus
 * handling whenever it changes.
 *
 * Usage: {editing && <EditCaptionModal post={editing} onSaved={replace} onClose={close} />}
 */
export function EditCaptionModal({
  post,
  onSaved,
  onClose,
}: {
  post: PostView;
  onSaved: (post: PostView) => void;
  onClose: () => void;
}) {
  const [caption, setCaption] = useState(post.caption);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // Modal puts initial focus on its close button; the caption field is where the work is. Deferred
  // so it lands after Modal's own effect, which has already noted the trigger to restore focus to.
  useEffect(() => {
    const t = window.setTimeout(() => fieldRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  // Escape and the backdrop must not dismiss mid-request. A ref keeps the handler's identity
  // stable: Modal re-runs its focus handling whenever `onClose` changes.
  const inFlight = useRef(false);
  const guardedClose = useCallback(() => {
    if (!inFlight.current) onClose();
  }, [onClose]);

  const save = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await api.updatePost(post.id, { caption });
      onSaved(res.post);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the caption. Try again.');
      inFlight.current = false;
      setSaving(false);
    }
  };

  const unchanged = caption === post.caption;
  const over = caption.length > CAPTION_MAX;

  return (
    <Modal title="Edit caption" onClose={guardedClose}>
      <div className="space-y-2">
        <Label htmlFor="edit-caption">Caption</Label>
        <Textarea
          id="edit-caption"
          ref={fieldRef}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          disabled={saving}
          aria-describedby="edit-caption-count"
          aria-invalid={over || undefined}
          rows={6}
        />
        <p
          id="edit-caption-count"
          className={over ? 'tnum text-caption text-error' : 'tnum text-caption text-muted'}
        >
          {caption.length.toLocaleString()} / {CAPTION_MAX.toLocaleString()} characters
          {over && ' (too long)'}
        </p>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving || unchanged || over}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Modal>
  );
}
