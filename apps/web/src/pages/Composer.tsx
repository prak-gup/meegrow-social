import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type {
  ConnectionView,
  MediaRef,
  PostValidationIssue,
  PostView,
  QueueView,
} from '@meegrow-social/contracts';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { providerVisible } from '../lib/devProviders';
import { platformMeta } from '../lib/platforms';
import {
  CAPTION_MAX,
  MEDIA_MAX,
  SCHEDULE_MODES,
  accountWarnings,
  buildCreatePostInput,
  buildValidationInput,
  busyLabel,
  contractRejected,
  hasErrors,
  isDirty,
  nextSlotError,
  nextSlotFromView,
  nextSlotText,
  outcomeMessage,
  plural,
  postStatusSummary,
  scheduleSummary,
  selectedConnections,
  submitLabel,
  toLocalInputValue,
  validateForm,
  type ComposerForm,
  type NextSlot,
  type ScheduleMode,
} from '../lib/composer';
import { AccountPicker } from '../components/AccountPicker';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Input } from '../components/ui/Input';
import { Label } from '../components/ui/Label';
import { Modal } from '../components/ui/Modal';
import { PlatformBadge } from '../components/ui/PlatformBadge';
import { Select } from '../components/ui/Select';
import { Textarea } from '../components/ui/Textarea';
import {
  CalendarBlank,
  CheckCircle,
  Clock,
  CloseIcon,
  ImageIcon,
  Play,
  Plugs,
  Plus,
  WarningCircle,
} from '../lib/icons';

/** The segment's word, and the line under the control once it is picked. */
const MODE_COPY: Record<ScheduleMode, { label: string; description: string }> = {
  draft: { label: 'Draft', description: 'Keep it for later. Nothing is sent.' },
  now: { label: 'Now', description: 'Posts straight away to the selected accounts.' },
  at: { label: 'Schedule', description: 'Pick a date and time.' },
  queue: { label: 'Queue', description: 'Takes the next free slot in a queue.' },
};

/** Platforms whose posts lead with the picture; elsewhere the text comes first. */
const MEDIA_FIRST = new Set(['instagram', 'youtube']);

/** An uploaded file: the ref the API needs, plus the file name for labels. */
interface MediaItem {
  ref: MediaRef;
  name: string;
}

interface Outcome {
  message: string;
  statuses: string;
  failed: boolean;
}

/** One block of the editor: a small heading, then its controls. `fieldset` groups checkboxes/radios. */
function Section({
  title,
  hint,
  fieldset = false,
  children,
}: {
  title: string;
  hint?: ReactNode;
  fieldset?: boolean;
  children: ReactNode;
}) {
  const head = (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
      {fieldset ? (
        <legend className="float-left p-0 text-sm font-semibold text-ink">{title}</legend>
      ) : (
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
      )}
      {hint && <p className="text-caption text-muted">{hint}</p>}
    </div>
  );
  const box = 'min-w-0 border-b border-hairline-soft p-4 last:border-b-0';
  return fieldset ? (
    <fieldset className={box}>
      {head}
      <div className="clear-both space-y-2">{children}</div>
    </fieldset>
  ) : (
    <section className={box}>
      {head}
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/** Inline field error: icon + text, so it is not colour alone; linked to its field by id. */
function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-caption text-error">
      <WarningCircle size={16} className="mt-0.5 flex-none" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** The four ways to send, as one segmented control. Real radios, so arrow keys move between them. */
function ModeSegments({
  mode,
  onChange,
}: {
  mode: ScheduleMode;
  onChange: (mode: ScheduleMode) => void;
}) {
  return (
    <div className="inline-flex w-full rounded-sm border border-muted-soft p-0.5 sm:w-auto">
      {SCHEDULE_MODES.map((m) => (
        <label key={m} className="relative flex-1 sm:flex-none">
          <input
            type="radio"
            name="schedule-mode"
            className="peer sr-only"
            checked={mode === m}
            onChange={() => onChange(m)}
          />
          <span className="flex h-10 cursor-pointer items-center justify-center rounded-xs px-3.5 text-base font-medium text-muted hover:text-ink peer-checked:bg-ink peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink md:h-7 md:text-sm">
            {MODE_COPY[m].label}
          </span>
        </label>
      ))}
    </div>
  );
}

function MediaThumb({ item, onRemove }: { item: MediaItem; onRemove: () => void }) {
  const { ref, name } = item;
  return (
    <li className="relative flex-none">
      {ref.kind === 'image' && ref.url ? (
        <img
          src={ref.url}
          alt={name}
          className="h-14 w-14 rounded-sm border border-hairline object-cover"
        />
      ) : (
        <span
          className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-sm border border-hairline bg-surface-soft px-1 text-center"
          title={name}
        >
          {ref.kind === 'video' ? (
            <Play size={16} weight="fill" className="text-muted" aria-hidden="true" />
          ) : (
            <ImageIcon size={16} className="text-muted" aria-hidden="true" />
          )}
          <span className="w-full truncate text-micro text-muted">
            <span className="sr-only">{ref.kind === 'video' ? 'Video: ' : 'Image: '}</span>
            {name}
          </span>
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-hairline bg-canvas text-ink shadow-1 hover:bg-surface-soft"
      >
        <CloseIcon size={10} weight="bold" />
      </button>
    </li>
  );
}

/**
 * What goes out, laid out like a post: the account, the caption, the media. Neutral on purpose —
 * it follows each platform's order (picture first or text first) but imitates no network's chrome.
 * With several accounts selected, a switcher picks whose post is shown.
 */
function Preview({
  accounts,
  caption,
  media,
  when,
}: {
  accounts: ConnectionView[];
  caption: string;
  media: MediaItem[];
  when: string;
}) {
  const [pickedId, setPickedId] = useState('');
  const current = accounts.find((c) => c.id === pickedId) ?? accounts[0];
  const platform = current
    ? platformMeta({ identifier: current.provider, displayName: current.provider })
    : null;
  const first = media[0];
  const mediaFirst = current ? MEDIA_FIRST.has(current.provider) : false;

  const text = (
    <p
      className={cn(
        'max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2.5 text-sm',
        caption ? 'text-body-ink' : 'text-muted',
      )}
    >
      {caption || 'Your caption will appear here.'}
    </p>
  );
  const picture = first && (
    <div className="relative">
      {first.ref.kind === 'image' && first.ref.url ? (
        <img
          src={first.ref.url}
          alt={`Preview of ${first.name}`}
          className="aspect-square w-full object-cover"
        />
      ) : (
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-1 bg-surface-strong text-muted">
          {first.ref.kind === 'video' ? (
            <Play size={28} weight="fill" aria-hidden="true" />
          ) : (
            <ImageIcon size={28} aria-hidden="true" />
          )}
          <span className="max-w-full truncate px-4 text-caption">
            {first.ref.kind === 'video' ? 'Video' : 'Image'}: {first.name}
          </span>
        </div>
      )}
      {media.length > 1 && (
        <span className="tnum absolute right-2 top-2 rounded-full bg-scrim/60 px-2 py-0.5 text-micro font-medium text-white">
          1 / {media.length}
          <span className="sr-only"> media items</span>
        </span>
      )}
    </div>
  );

  return (
    <section aria-labelledby="preview-title" className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="preview-title" className="text-sm font-semibold text-ink">
          Preview
        </h2>
        {accounts.length > 1 && (
          <div role="group" aria-label="Preview as" className="flex flex-wrap justify-end gap-1">
            {accounts.map((c) => {
              const on = c.id === current?.id;
              const label = platformMeta({ identifier: c.provider, displayName: c.provider }).label;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  aria-label={`Preview as ${c.displayName}, ${label}`}
                  title={`${c.displayName} · ${label}`}
                  onClick={() => setPickedId(c.id)}
                  className={cn(
                    'grid h-11 w-11 place-items-center rounded-sm border md:h-8 md:w-8',
                    on ? 'border-ink bg-surface-soft' : 'border-transparent hover:bg-surface-soft',
                  )}
                >
                  <PlatformBadge provider={c.provider} name={c.displayName} size="sm" />
                </button>
              );
            })}
          </div>
        )}
      </div>
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2.5 border-b border-hairline-soft px-3 py-2.5">
          {current ? (
            <PlatformBadge provider={current.provider} name={current.displayName} />
          ) : (
            <span
              className="grid h-7 w-7 flex-none place-items-center rounded-md bg-surface-strong text-muted"
              aria-hidden="true"
            >
              <Plugs size={16} />
            </span>
          )}
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-semibold text-ink">
              {current ? current.displayName : 'No account selected'}
            </span>
            <span className="truncate text-micro text-muted">
              {platform ? platform.label : 'Select an account to post as'}
              {accounts.length > 1 && ` · 1 of ${accounts.length} accounts`}
            </span>
          </div>
        </div>
        {mediaFirst ? (
          <>
            {picture}
            {text}
          </>
        ) : (
          <>
            {text}
            {picture}
          </>
        )}
      </Card>
      <p className="mt-2 flex items-start gap-1.5 text-caption text-muted">
        <Clock size={14} className="mt-0.5 flex-none" aria-hidden="true" />
        <span>{when}</span>
      </p>
    </section>
  );
}

/** How long typing pauses before the accounts are re-checked against the post. */
const VALIDATE_DELAY_MS = 600;

/**
 * Create a post, as a wide panel over the page it was opened from. The address is still
 * `/composer` (App.tsx keeps the page beneath on screen), so it deep-links and Back closes it. It
 * behaves as a dialog: focus moves in and is kept in, the page behind is inert, focus returns to
 * what opened it, and Escape — like Cancel and the backdrop — asks before throwing typed work away.
 */
export function Composer({
  background = '/content',
}: {
  /** The page the panel sits over and returns to (lib/composer `composerBackground`). */
  background?: string;
}) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const [conns, setConns] = useState<ConnectionView[]>([]);
  const [queues, setQueues] = useState<QueueView[]>([]);
  const [load, setLoad] = useState<{ state: 'loading' | 'ready' | 'error'; message?: string }>({
    state: 'loading',
  });

  const [caption, setCaption] = useState('');
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [connectionIds, setConnectionIds] = useState<string[]>([]);
  const [mode, setMode] = useState<ScheduleMode>('draft');
  const [at, setAt] = useState('');
  const [queueId, setQueueId] = useState('');
  const [nextSlot, setNextSlot] = useState<NextSlot | null>(null);
  const [issues, setIssues] = useState<PostValidationIssue[]>([]);

  const [uploading, setUploading] = useState(0);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [attempted, setAttempted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const outcomeHeading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const captionField = useRef<HTMLTextAreaElement>(null);

  const client = me?.user.memberships.find((m) => m.workspaceId === me.activeWorkspaceId);

  const fetchAccounts = useCallback(async () => {
    setLoad({ state: 'loading' });
    try {
      const [c, q] = await Promise.all([api.listConnections(), api.listQueues()]);
      // Fakes stay dev-only (lib/devProviders), including for the default selection.
      const visible = c.connections.filter((conn) => providerVisible(conn.provider));
      setConns(visible);
      setQueues(q.queues);
      // Defaults as before: the first visible account and the first queue.
      setConnectionIds(visible[0] ? [visible[0].id] : []);
      setQueueId(q.queues[0]?.id ?? '');
      setLoad({ state: 'ready' });
    } catch (e) {
      setLoad({
        state: 'error',
        message: e instanceof Error ? e.message : 'Could not load accounts and queues.',
      });
    }
  }, []);
  useEffect(() => {
    void fetchAccounts();
  }, [fetchAccounts]);

  // Dialog housekeeping: the page behind does not scroll, and focus goes back to whatever opened
  // the panel. The opener is noted once (an effect can run twice in development) and focused a
  // tick after the panel is really gone, because the page behind is still inert while it unmounts.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current ??= document.activeElement as HTMLElement | null;
    const node = panel.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    node?.focus();
    return () => {
      document.body.style.overflow = overflow;
      window.setTimeout(() => {
        if (!node?.isConnected) opener.current?.focus?.();
      }, 0);
    };
  }, []);
  // The caption is where the work starts, so it takes focus once the form is there.
  useEffect(() => {
    if (load.state === 'ready') captionField.current?.focus();
  }, [load.state]);

  // Preview of when a queued post would go out. It only informs: a failed or empty preview never
  // blocks the submit. A slow answer for a queue the operator already left must not be shown.
  useEffect(() => {
    if (mode !== 'queue' || !queueId) {
      setNextSlot(null);
      return;
    }
    let stale = false;
    setNextSlot({ state: 'loading' });
    api
      .queueSlots(queueId, 1)
      .then((view) => {
        if (!stale) setNextSlot(nextSlotFromView(view));
      })
      .catch((e: unknown) => {
        if (stale) return;
        const status = e instanceof ApiError ? e.status : undefined;
        setNextSlot({ state: 'error', message: nextSlotError(status) });
      });
    return () => {
      stale = true;
    };
  }, [mode, queueId]);

  // Which accounts can take this post as written: a dry run (`POST /v1/posts/validate`) over EVERY
  // account, so one that cannot is marked before it is picked. The rules are the server's — each
  // provider's own — and none is restated here. The validator stops at a contract failure, so the
  // accounts it rejected there are set aside and the rest are asked about once more. Advisory only:
  // a failed dry run costs the warnings, never the form, and the server still decides on submit.
  const mediaKey = media.map((m) => m.ref.mediaId).join(',');
  useEffect(() => {
    if (conns.length === 0) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const draft = { caption, media: media.map((m) => m.ref) };
        try {
          let found = (await api.validatePost(buildValidationInput(draft, conns))).issues;
          const rejected = new Set(contractRejected(found));
          const rest = conns.filter((c) => !rejected.has(c.id));
          if (rejected.size > 0 && rest.length > 0) {
            const again = await api.validatePost(buildValidationInput(draft, rest));
            found = [...found, ...again.issues];
          }
          if (!stale) setIssues(found);
        } catch {
          if (!stale) setIssues([]);
        }
      })();
    }, VALIDATE_DELAY_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
    // `mediaKey` stands for `media`: the refs matter, not the array's identity.
  }, [caption, mediaKey, conns]);

  useEffect(() => {
    if (outcome) outcomeHeading.current?.focus();
  }, [outcome]);

  const form: ComposerForm = {
    caption,
    media: media.map((m) => m.ref),
    connectionIds,
    mode,
    at,
    queueId,
  };
  const errors = validateForm(form, queues, new Date());
  const targets = selectedConnections(conns, connectionIds);
  const warnings = accountWarnings(conns, issues);
  const flagged = targets.filter((c) => warnings.has(c.id)).length;
  const queueName = queues.find((q) => q.id === queueId)?.name;
  const atError = errors.at && (attempted || at !== '') ? errors.at : undefined;
  const accountsError = attempted ? errors.accounts : undefined;
  const queueError = attempted ? errors.queue : undefined;
  const mediaFull = media.length + uploading >= MEDIA_MAX;

  const addFiles = async (list: Iterable<File> | null) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    const room = Math.max(0, MEDIA_MAX - media.length - uploading);
    const accepted = files.slice(0, room);
    const problems: string[] = [];
    if (accepted.length < files.length) {
      problems.push(
        `A post can have at most ${MEDIA_MAX} media items. ${plural(files.length - accepted.length, 'file was', 'files were')} not added.`,
      );
    }
    setMediaError(null);
    setUploading((n) => n + accepted.length);
    for (const f of accepted) {
      try {
        const m = await api.uploadMedia(f);
        setMedia((prev) => [
          ...prev,
          { ref: { mediaId: m.id, kind: m.kind, url: m.url ?? undefined }, name: f.name },
        ]);
      } catch (e) {
        problems.push(`${f.name}: ${e instanceof Error ? e.message : 'media upload failed'}.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (problems.length > 0) setMediaError(problems.join(' '));
  };

  const send = async () => {
    // Re-validate against the clock now: a scheduled time can have slipped into the past while the
    // form (or the confirm dialog) was open.
    if (hasErrors(validateForm(form, queues, new Date()))) {
      setAttempted(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.createPost(buildCreatePostInput(form, conns));
      const posts: PostView[] = res.posts;
      setOutcome({
        message: outcomeMessage(mode, targets.length, { at, queueName }),
        statuses: postStatusSummary(posts),
        failed: posts.some((p) => p.status === 'failed'),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = () => {
    setAttempted(true);
    if (hasErrors(errors)) return;
    if (mode === 'now') setConfirming(true);
    else void send();
  };

  const closeConfirm = useCallback(() => setConfirming(false), []);
  const keepEditing = useCallback(() => setDiscarding(false), []);

  // Leave for `to` (the page beneath by default). After a post was created the page is told to
  // reload its list, since it stayed mounted under the panel the whole time.
  const leave = (to: string = background) =>
    navigate(to, outcome ? { state: { refreshed: Date.now() } } : undefined);
  // Cancel, the close button, the backdrop and Escape all come here: typed work is never thrown
  // away without asking, and nothing closes mid-request.
  const requestClose = () => {
    if (busy) return;
    if (!outcome && isDirty(form)) setDiscarding(true);
    else leave();
  };

  const onPanelKey = (e: React.KeyboardEvent) => {
    // A dialog on top (publish-now, discard) handles its own keys.
    if (confirming || discarding) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      // Stopped here: the "Discard?" dialog this may open listens for Escape on the document, and
      // would otherwise be closed by the very key press that opened it.
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = Array.from(
      panel.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([hidden]), select:not([disabled]), textarea:not([disabled])',
      ) ?? [],
    ).filter((el) => el.tabIndex !== -1);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    const current = document.activeElement;
    if (e.shiftKey && (current === first || current === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && current === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const reset = () => {
    setCaption('');
    setMedia([]);
    setConnectionIds(conns[0] ? [conns[0].id] : []);
    setMode('draft');
    setAt('');
    setQueueId(queues[0]?.id ?? '');
    setMediaError(null);
    setAttempted(false);
    setError(null);
    setOutcome(null);
  };

  const over = caption.length > CAPTION_MAX;
  const accountsErrorId = 'accounts-error';
  const captionErrorId = 'caption-error';
  const atErrorId = 'at-error';
  const queueErrorId = 'queue-error';
  const mediaErrorId = 'media-error';
  const queueSlotId = 'queue-slot';
  const editing = load.state === 'ready' && conns.length > 0 && !outcome;
  const when = scheduleSummary(mode, at, queueName, nextSlot);

  let content: ReactNode;
  if (load.state === 'loading') {
    content = (
      <p className="p-5 text-body text-muted" role="status">
        Loading accounts…
      </p>
    );
  } else if (load.state === 'error') {
    content = (
      <div className="p-5">
        <ErrorState
          title="Could not load the composer"
          message={load.message}
          onRetry={() => void fetchAccounts()}
        />
      </div>
    );
  } else if (conns.length === 0) {
    content = (
      <div className="p-5">
        <EmptyState
          icon={Plugs}
          title="No connected accounts"
          description="Connect a social account for this client before creating a post."
          action={
            <Button asChild>
              <Link to="/connections">Go to Connections</Link>
            </Button>
          }
        />
      </div>
    );
  } else if (outcome) {
    content = (
      <div className="p-5">
        <CheckCircle size={28} weight="fill" className="text-status-ok" aria-hidden="true" />
        <h3
          ref={outcomeHeading}
          tabIndex={-1}
          className="mt-3 text-base font-semibold text-ink focus:outline-none"
        >
          {outcome.message}
        </h3>
        {outcome.statuses && (
          <p className="mt-1 flex items-center gap-1.5 text-body text-muted">
            {outcome.failed && (
              <WarningCircle size={18} className="text-status-bad" aria-hidden="true" />
            )}
            Status: {outcome.statuses}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => leave('/calendar')}>
            <CalendarBlank size={18} />
            View calendar
          </Button>
          <Button variant="outline" onClick={() => leave('/content')}>
            View content
          </Button>
          <Button variant="outline" onClick={reset}>
            Create another
          </Button>
          <Button onClick={() => leave()}>Done</Button>
        </div>
      </div>
    );
  } else {
    content = (
      // lg: content over preview on the left, accounts down the right. xl: three columns.
      <div className="grid lg:min-h-full lg:grid-cols-composer lg:grid-rows-head-fill xl:grid-cols-composer-wide xl:grid-rows-1">
        {/* Content first: what is being said, then with what, then when. */}
        <div className="min-w-0 lg:col-start-1 lg:row-start-1 lg:border-r lg:border-hairline-soft">
          <Section
            title="Caption"
            hint={
              <span id="caption-count" className={cn('tnum', over && 'font-semibold text-error')}>
                {caption.length.toLocaleString()} / {CAPTION_MAX.toLocaleString()}
              </span>
            }
          >
            <Label htmlFor="caption" className="sr-only">
              Caption
            </Label>
            <Textarea
              id="caption"
              ref={captionField}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Write something…"
              rows={7}
              aria-invalid={over}
              aria-describedby={cn('caption-count', over && captionErrorId)}
            />
            {over && errors.caption && (
              <FieldError id={captionErrorId}>{errors.caption}</FieldError>
            )}
          </Section>

          <Section title="Media" hint={`${media.length} of ${MEDIA_MAX} · photos and videos`}>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void addFiles(e.dataTransfer.files);
              }}
              className={cn(
                'rounded-sm border border-dashed p-2 transition-colors',
                dragging ? 'border-ink bg-surface-soft' : 'border-hairline-strong',
              )}
            >
              <ul className="flex flex-wrap items-center gap-2.5" aria-label="Attached media">
                {media.map((item) => (
                  <MediaThumb
                    key={item.ref.mediaId}
                    item={item}
                    onRemove={() =>
                      setMedia((prev) => prev.filter((m) => m.ref.mediaId !== item.ref.mediaId))
                    }
                  />
                ))}
                <li className="flex min-w-0 items-center gap-2.5">
                  <button
                    type="button"
                    disabled={mediaFull}
                    onClick={() => fileInput.current?.click()}
                    aria-label={uploading > 0 ? 'Uploading' : 'Add photos or videos'}
                    aria-describedby={cn('media-hint', mediaError && mediaErrorId)}
                    className="grid h-14 w-14 flex-none place-items-center rounded-sm border border-hairline-strong bg-canvas text-ink hover:bg-surface-soft disabled:opacity-50"
                  >
                    <Plus size={18} aria-hidden="true" />
                  </button>
                  <p
                    id="media-hint"
                    className="text-caption text-muted"
                    role={uploading > 0 ? 'status' : undefined}
                  >
                    {uploading > 0
                      ? `Uploading ${plural(uploading, 'file')}…`
                      : mediaFull
                        ? `Maximum of ${MEDIA_MAX} reached. Remove one to add another.`
                        : 'Add photos or videos, or drop files here.'}
                  </p>
                </li>
              </ul>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept="image/*,video/*"
                hidden
                tabIndex={-1}
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            {mediaError && <FieldError id={mediaErrorId}>{mediaError}</FieldError>}
          </Section>

          <Section title="When to post" fieldset>
            <ModeSegments mode={mode} onChange={setMode} />
            {(mode === 'draft' || mode === 'now') && (
              <p className="text-caption text-muted">{MODE_COPY[mode].description}</p>
            )}

            {mode === 'at' && (
              <div className="max-w-xs space-y-1.5">
                <Label htmlFor="at">Publish at</Label>
                <Input
                  id="at"
                  type="datetime-local"
                  value={at}
                  min={toLocalInputValue(new Date())}
                  onChange={(e) => setAt(e.target.value)}
                  aria-invalid={Boolean(atError)}
                  aria-describedby={atError ? atErrorId : undefined}
                />
                {atError && <FieldError id={atErrorId}>{atError}</FieldError>}
              </div>
            )}
            {mode === 'queue' && (
              <div className="max-w-xs space-y-1.5">
                <Label htmlFor="queue">Queue</Label>
                {queues.length > 0 ? (
                  <Select
                    id="queue"
                    value={queueId}
                    onChange={(e) => setQueueId(e.target.value)}
                    aria-invalid={Boolean(queueError)}
                    aria-describedby={
                      cn(nextSlot && queueSlotId, queueError && queueErrorId) || undefined
                    }
                  >
                    {queues.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <p className="text-sm text-muted">This client has no queues yet.</p>
                )}
                {/* A live region, so changing the queue announces its slot. */}
                <p id={queueSlotId} role="status" className="tnum text-caption text-muted">
                  {nextSlot && nextSlotText(nextSlot)}
                </p>
                {queueError && <FieldError id={queueErrorId}>{queueError}</FieldError>}
              </div>
            )}
          </Section>
        </div>

        <div className="min-w-0 border-t border-hairline-soft lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-t-0 xl:row-span-1 xl:border-r xl:border-hairline-soft">
          <Section
            title="Post to"
            hint={
              <>
                {targets.length} of {conns.length} selected
                {flagged > 0 && (
                  <span className="text-status-warn"> · {flagged} with a warning</span>
                )}
              </>
            }
          >
            <AccountPicker
              connections={conns}
              selectedIds={connectionIds}
              onChange={setConnectionIds}
              warnings={warnings}
              describedBy={accountsError ? accountsErrorId : undefined}
            />
            {accountsError && <FieldError id={accountsErrorId}>{accountsError}</FieldError>}
          </Section>
        </div>

        <div className="min-w-0 border-t border-hairline-soft p-4 lg:col-start-1 lg:row-start-2 lg:border-r lg:border-hairline-soft xl:col-start-3 xl:row-start-1 xl:border-r-0 xl:border-t-0">
          <div className="xl:sticky xl:top-4">
            <Preview accounts={targets} caption={caption} media={media} when={when} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-scrim/40" aria-hidden="true" onClick={requestClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-title"
        tabIndex={-1}
        onKeyDown={onPanelKey}
        className="absolute inset-y-0 right-0 flex w-full max-w-sheet flex-col bg-canvas shadow-1 focus:outline-none"
      >
        <header className="flex flex-none items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <div className="min-w-0">
            <h2 id="composer-title" className="text-title font-semibold text-ink">
              Create post
            </h2>
            <p className="truncate text-sm text-muted">
              {client
                ? `Posting as ${client.name}.`
                : 'Write once, then save, schedule, or queue it.'}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close composer"
            className="-mr-1.5 grid h-11 w-11 flex-none place-items-center rounded-sm text-muted hover:bg-surface-strong hover:text-ink md:h-8 md:w-8"
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>

        {editing && (
          <footer className="flex-none border-t border-hairline bg-canvas px-4 py-3">
            {error && (
              <p role="alert" className="mb-2 flex items-start gap-1.5 text-sm text-error">
                <WarningCircle size={16} className="mt-0.5 flex-none" aria-hidden="true" />
                <span>Could not create the post: {error}</span>
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <p className="mr-auto hidden min-w-0 items-center gap-1.5 truncate text-caption text-muted sm:flex">
                <Clock size={14} className="flex-none" aria-hidden="true" />
                <span className="truncate">{when}</span>
              </p>
              <Button variant="outline" onClick={requestClose} disabled={busy}>
                Cancel
              </Button>
              {/* The label says what pressing it does: Save draft / Publish now / Schedule / Add to queue. */}
              <Button disabled={busy || uploading > 0} onClick={onSubmit}>
                {busy ? busyLabel(mode) : submitLabel(mode, targets.length)}
              </Button>
            </div>
          </footer>
        )}
      </div>

      {confirming && (
        <Modal title="Publish now?" onClose={closeConfirm}>
          <p className="text-body text-body-ink">
            This sends the post immediately, for real, to {plural(targets.length, 'account')}:
          </p>
          <ul className="mt-3 space-y-2">
            {targets.map((c) => (
              <li key={c.id} className="flex items-center gap-2.5">
                <PlatformBadge provider={c.provider} name={c.displayName} size="sm" />
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-sm font-medium text-ink">{c.displayName}</span>
                  <span className="truncate text-micro text-muted">
                    {platformMeta({ identifier: c.provider, displayName: c.provider }).label}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={closeConfirm}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
                void send();
              }}
            >
              {submitLabel('now', targets.length)}
            </Button>
          </div>
        </Modal>
      )}

      {discarding && (
        <Modal title="Discard this post?" onClose={keepEditing}>
          <p className="text-sm text-body-ink">
            What you have written and attached has not been saved and will be lost. To keep it, save
            it as a draft instead.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={keepEditing}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={() => leave()}>
              Discard
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
