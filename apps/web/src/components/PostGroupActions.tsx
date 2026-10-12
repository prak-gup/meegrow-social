import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PostGroupSummary, PostView } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { plural, toLocalInputValue, validateScheduleAt } from '../lib/composer';
import { ArrowClockwise, ArrowSquareOut, Clock, Copy, PencilSimple, XCircle } from '../lib/icons';
import { platformMeta } from '../lib/platforms';
import { groupActions, groupTime, type PostGroup } from '../lib/postGroups';
import { partialFailureText, runOnPosts } from '../lib/postOps';
import { CancelPostModal } from './CancelPostModal';
import { EditCaptionModal } from './EditCaptionModal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Label } from './ui/Label';
import { Modal } from './ui/Modal';
import type { RowMenuItem } from './ui/RowMenu';

export type PostChange = 'caption' | 'time' | 'cancel' | 'retry';

interface DialogProps {
  posts: PostView[];
  accountName: (post: PostView) => string;
  onApplied: (posts: PostView[]) => void;
  onDone: () => void;
  onClose: () => void;
}

/** A modal's close guard: Escape and the backdrop must not dismiss it mid-request. */
function useGuardedClose(onClose: () => void) {
  const inFlight = useRef(false);
  const guardedClose = useCallback(() => {
    if (!inFlight.current) onClose();
  }, [onClose]);
  return { inFlight, guardedClose };
}

/** Pick a time for the draft and scheduled variants of a post. Setting one schedules a draft. */
function RescheduleModal({ posts, accountName, onApplied, onDone, onClose }: DialogProps) {
  const current = groupTime(posts);
  const [at, setAt] = useState(
    current && current.getTime() > Date.now() ? toLocalInputValue(current) : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const { inFlight, guardedClose } = useGuardedClose(onClose);
  const moving = posts.some((p) => p.status === 'scheduled');
  const invalid = validateScheduleAt(at, new Date());

  const save = async () => {
    setTouched(true);
    // Checked against the clock at the moment of saving: the time can slip into the past while
    // the dialog is open.
    if (inFlight.current || validateScheduleAt(at, new Date())) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const publishAt = new Date(at);
    const result = await runOnPosts(
      posts,
      async (p) => (await api.updatePost(p.id, { publishAt })).post,
    );
    if (result.done.length > 0) onApplied(result.done);
    if (result.failed.length === 0) {
      onDone();
      return;
    }
    setError(partialFailureText(result, 'scheduled', accountName));
    inFlight.current = false;
    setBusy(false);
  };

  return (
    <Modal title={moving ? 'Reschedule post' : 'Schedule post'} onClose={guardedClose}>
      <div className="space-y-1.5">
        <Label htmlFor="reschedule-at">Publish at</Label>
        <Input
          id="reschedule-at"
          type="datetime-local"
          value={at}
          min={toLocalInputValue(new Date())}
          disabled={busy}
          onChange={(e) => setAt(e.target.value)}
          aria-invalid={touched && Boolean(invalid)}
          aria-describedby="reschedule-note"
        />
        {touched && invalid && (
          <p role="alert" className="text-caption text-error">
            {invalid}
          </p>
        )}
      </div>
      <p id="reschedule-note" className="mt-3 text-sm text-muted">
        It publishes for real at that time to {plural(posts.length, 'account')}:{' '}
        {posts.map(accountName).join(', ')}.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? 'Scheduling…' : moving ? 'Reschedule' : 'Schedule'}
        </Button>
      </div>
    </Modal>
  );
}

/** Confirm retrying the failed variants of a post. A retry publishes for real. */
function RetryModal({ posts, accountName, onApplied, onDone, onClose }: DialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(posts);
  const { inFlight, guardedClose } = useGuardedClose(onClose);

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await runOnPosts(remaining, async (p) => (await api.retryPost(p.id)).post);
    if (result.done.length > 0) onApplied(result.done);
    if (result.failed.length === 0) {
      onDone();
      return;
    }
    setError(partialFailureText(result, 'retried', accountName));
    setRemaining(result.failed.map((f) => f.post));
    inFlight.current = false;
    setBusy(false);
  };

  return (
    <Modal title="Retry publishing?" onClose={guardedClose}>
      <p className="text-sm text-body-ink">
        This queues the post again and publishes it for real — straight away, or at its scheduled
        time if that is still ahead.
      </p>
      <ul className="mt-3 space-y-2">
        {remaining.map((p) => (
          <li key={p.id} className="text-sm">
            <span className="font-medium text-ink">{accountName(p)}</span>
            {p.error && (
              <span className="block break-words text-caption text-muted">{p.error}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-caption text-muted">
        Fix the cause first, or it fails again. If the platform shows the post did go out, do not
        retry: it would be posted a second time.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Not now
        </Button>
        <Button onClick={() => void confirm()} disabled={busy}>
          {busy
            ? 'Retrying…'
            : remaining.length > 1
              ? `Retry on ${remaining.length} accounts`
              : 'Retry'}
        </Button>
      </div>
    </Modal>
  );
}

const DONE: Record<PostChange, string> = {
  caption: 'Caption saved.',
  time: 'Post scheduled.',
  cancel: 'Post cancelled.',
  retry: 'Queued to publish again.',
};

const ICON = 14;

/**
 * The actions of a post group, shared by Content and Calendar so a post offers the same things
 * wherever it is shown: the menu items valid for its variants' statuses, and the dialogs behind
 * them. Render `dialogs` once on the page and pass `items(group)` to a <RowMenu>.
 *
 * Usage: const actions = usePostGroupActions({ accounts, onChanged, onDuplicated });
 *        <RowMenu label="…" items={actions.items(group)} />  …  {actions.dialogs}
 */
export function usePostGroupActions(opts: {
  /** Account name per connection id. */
  accounts: ReadonlyMap<string, string>;
  /** Variants changed on the server; swap them into whatever is on screen. */
  onChanged: (posts: PostView[], change: PostChange) => void;
  /** A group was copied into new drafts. */
  onDuplicated: (group: PostGroupSummary) => void;
}): {
  items: (group: PostGroup) => RowMenuItem[];
  dialogs: ReactNode;
  /** What the last action did, for a live region. */
  notice: string;
  /** A failure with no dialog to show it in (duplicate). */
  error: string | null;
  clearMessages: () => void;
} {
  const { accounts, onChanged, onDuplicated } = opts;
  const [dialog, setDialog] = useState<{ kind: PostChange; posts: PostView[] } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const accountName = useCallback(
    (post: PostView) => {
      const platform = platformMeta({ identifier: post.provider, displayName: post.provider });
      const account = accounts.get(post.connectionId);
      return account ? `${account} (${platform.label})` : platform.label;
    },
    [accounts],
  );

  const close = useCallback(() => setDialog(null), []);
  const clearMessages = useCallback(() => {
    setNotice('');
    setError(null);
  }, []);
  const open = (kind: PostChange, posts: PostView[]) => {
    clearMessages();
    setDialog({ kind, posts });
  };

  const duplicate = async (group: PostGroup, captionOnly: boolean) => {
    clearMessages();
    try {
      const res = await api.duplicatePostGroup(group.id);
      onDuplicated(res.group);
      setNotice(
        captionOnly
          ? 'Duplicated the caption as a draft. Attach the media again before scheduling — an imported post’s files are not kept here.'
          : 'Duplicated as a draft. Nothing is scheduled.',
      );
    } catch (e) {
      setError(`Couldn’t duplicate the post: ${e instanceof Error ? e.message : 'try again.'}`);
    }
  };

  const items = (group: PostGroup): RowMenuItem[] => {
    // An imported post offers only what is safe for something already live elsewhere: a copy of
    // its caption as a new draft, and a way to look at it. `groupActions` leaves the rest empty.
    const { imported, editable, cancelable, failed, links } = groupActions(group.posts);
    const out: RowMenuItem[] = [];
    if (editable.length > 0) {
      out.push({
        label: 'Edit caption',
        icon: <PencilSimple size={ICON} />,
        onSelect: () => open('caption', editable),
      });
      out.push({
        label: editable.some((p) => p.status === 'scheduled') ? 'Reschedule' : 'Schedule',
        icon: <Clock size={ICON} />,
        onSelect: () => open('time', editable),
      });
    }
    if (failed.length > 0) {
      out.push({
        label: failed.length > 1 ? `Retry ${failed.length} failed` : 'Retry',
        icon: <ArrowClockwise size={ICON} />,
        onSelect: () => open('retry', failed),
      });
    }
    if (
      !group.posts.some(
        (p) => p.options?.kind === 'wordpress' && p.options.remote?.bodyFormat === 'html',
      )
    )
      out.push({
        label: imported ? 'Duplicate caption as draft' : 'Duplicate as draft',
        icon: <Copy size={ICON} />,
        onSelect: () => void duplicate(group, imported),
      });
    // Two accounts on one platform need the account name to be told apart.
    const perPlatform = new Map<string, number>();
    for (const l of links)
      perPlatform.set(l.post.provider, (perPlatform.get(l.post.provider) ?? 0) + 1);
    for (const { post, url } of links) {
      const platform = platformMeta({ identifier: post.provider, displayName: post.provider });
      const account = accounts.get(post.connectionId);
      const ambiguous = (perPlatform.get(post.provider) ?? 0) > 1 && account;
      out.push({
        label: `View on ${ambiguous ? account : platform.label}`,
        icon: <ArrowSquareOut size={ICON} />,
        onSelect: () => window.open(url, '_blank', 'noopener,noreferrer'),
      });
    }
    if (cancelable.length > 0) {
      out.push({
        label: 'Cancel post',
        icon: <XCircle size={ICON} />,
        danger: true,
        onSelect: () => open('cancel', cancelable),
      });
    }
    return out;
  };

  const dialogs = useMemo(() => {
    if (!dialog) return null;
    const props: DialogProps = {
      posts: dialog.posts,
      accountName,
      onApplied: (posts) => onChanged(posts, dialog.kind),
      onDone: () => {
        setDialog(null);
        setNotice(DONE[dialog.kind]);
      },
      onClose: close,
    };
    switch (dialog.kind) {
      case 'caption':
        return <EditCaptionModal {...props} />;
      case 'time':
        return <RescheduleModal {...props} />;
      case 'retry':
        return <RetryModal {...props} />;
      case 'cancel':
        return <CancelPostModal {...props} />;
    }
  }, [dialog, accountName, onChanged, close]);

  return { items, dialogs, notice, error, clearMessages };
}
