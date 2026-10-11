import { useCallback, useEffect, useRef, useState } from 'react';
import type { PostView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { plural } from '../lib/composer';
import { distinctCaptions } from '../lib/postGroups';
import { CAPTION_MAX } from '../lib/postList';
import { partialFailureText, runOnPosts } from '../lib/postOps';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Label } from './ui/Label';
import { Select } from './ui/Select';
import { Textarea } from './ui/Textarea';

/**
 * Edit the caption of a post's editable variants (the API only accepts this for draft/scheduled
 * posts). When the variants share one caption the edit applies to all of them; when they were
 * tailored per platform it applies to the one chosen, so a tailored caption is never overwritten by
 * accident. Failures stay in the dialog so the operator keeps their text; variants that did save
 * are reported through `onApplied` even then. `onClose` must be stable: Modal re-runs its focus
 * handling whenever it changes.
 *
 * Usage: {editing && <EditCaptionModal posts={editing} accountName={name} onApplied={apply} onDone={close} onClose={close} />}
 */
export function EditCaptionModal({
  posts,
  accountName,
  onApplied,
  onDone,
  onClose,
}: {
  /** The editable variants of one group. At least one. */
  posts: PostView[];
  accountName: (post: PostView) => string;
  /** Variants that were saved, as the API returned them. May be called on a partial failure. */
  onApplied: (posts: PostView[]) => void;
  /** Every targeted variant saved. */
  onDone: () => void;
  onClose: () => void;
}) {
  const tailored = distinctCaptions(posts).length > 1;
  const [targetId, setTargetId] = useState(posts[0]!.id);
  const targets = tailored ? posts.filter((p) => p.id === targetId) : posts;
  const original = targets[0]?.caption ?? '';
  const [caption, setCaption] = useState(original);
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

  const pickTarget = (id: string) => {
    setTargetId(id);
    setCaption(posts.find((p) => p.id === id)?.caption ?? '');
    setError(null);
  };

  const save = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    const result = await runOnPosts(
      targets,
      async (p) => (await api.updatePost(p.id, { caption })).post,
    );
    if (result.done.length > 0) onApplied(result.done);
    if (result.failed.length === 0) {
      onDone();
      return;
    }
    setError(partialFailureText(result, 'saved', accountName));
    inFlight.current = false;
    setSaving(false);
  };

  const unchanged = caption === original;
  const over = caption.length > CAPTION_MAX;

  return (
    <Modal title="Edit caption" onClose={guardedClose}>
      <div className="space-y-2">
        {tailored && (
          <div className="space-y-1.5">
            <Label htmlFor="edit-caption-target">Account</Label>
            <Select
              id="edit-caption-target"
              value={targetId}
              disabled={saving}
              onChange={(e) => pickTarget(e.target.value)}
            >
              {posts.map((p) => (
                <option key={p.id} value={p.id}>
                  {accountName(p)}
                </option>
              ))}
            </Select>
            <p className="text-caption text-muted">
              This post has a different caption per account, so each is edited on its own.
            </p>
          </div>
        )}
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
          {!tailored && targets.length > 1 && ` · applies to ${plural(targets.length, 'account')}`}
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
