import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ConnectionView, MediaRef, PostView, QueueView } from '@meegrow-social/contracts';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/cn';
import { providerVisible } from '../lib/devProviders';
import { platformMeta } from '../lib/platforms';
import {
  CAPTION_MAX,
  MEDIA_MAX,
  SCHEDULE_MODES,
  buildCreatePostInput,
  busyLabel,
  hasErrors,
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
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Input } from '../components/ui/Input';
import { Label } from '../components/ui/Label';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { Textarea } from '../components/ui/Textarea';
import {
  CalendarBlank,
  CheckCircle,
  Clock,
  CloseIcon,
  ImageIcon,
  Plugs,
  PlayCircle,
  WarningCircle,
} from '../lib/icons';

const MODE_COPY: Record<ScheduleMode, { title: string; description: string }> = {
  draft: { title: 'Save as draft', description: 'Keep it for later. Nothing is sent.' },
  now: { title: 'Publish now', description: 'Posts straight away to the selected accounts.' },
  at: { title: 'Schedule', description: 'Pick a date and time.' },
  queue: { title: 'Add to queue', description: 'Takes the next free slot in a queue.' },
};

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

/** Selected state is never colour alone: a thicker ring plus (for chips) a check icon. */
const choiceBox =
  'flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-md border bg-canvas p-3 text-left transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink';
const choiceOn = 'border-ink bg-surface-soft ring-1 ring-ink';
const choiceOff = 'border-hairline hover:bg-surface-soft';

/** A titled block of the editor. `fieldset` groups a set of checkboxes/radios under a legend. */
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
    <>
      {fieldset ? (
        <legend className="p-0 text-base font-semibold text-ink">{title}</legend>
      ) : (
        <h2 className="text-base font-semibold text-ink">{title}</h2>
      )}
      {hint && <p className="mt-0.5 text-caption text-muted">{hint}</p>}
    </>
  );
  return (
    <Card>
      {fieldset ? (
        <fieldset className="min-w-0 p-6">
          {head}
          <div className="mt-4 space-y-3">{children}</div>
        </fieldset>
      ) : (
        <section className="min-w-0 p-6">
          {head}
          <div className="mt-4 space-y-3">{children}</div>
        </section>
      )}
    </Card>
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

function PlatformTile({ conn, size = 'md' }: { conn: ConnectionView; size?: 'sm' | 'md' }) {
  const platform = platformMeta({ identifier: conn.provider, displayName: conn.provider });
  return (
    <span
      className={cn(
        'grid flex-none place-items-center rounded-sm text-white',
        platform.brand,
        size === 'md' ? 'h-9 w-9' : 'h-8 w-8',
      )}
      aria-hidden="true"
    >
      <platform.Icon size={size === 'md' ? 20 : 18} weight="fill" />
    </span>
  );
}

function AccountChip({
  conn,
  selected,
  onToggle,
  describedBy,
}: {
  conn: ConnectionView;
  selected: boolean;
  onToggle: () => void;
  describedBy?: string;
}) {
  const platform = platformMeta({ identifier: conn.provider, displayName: conn.provider });
  return (
    <label className="relative block">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={selected}
        onChange={onToggle}
        aria-describedby={describedBy}
      />
      <span className={cn(choiceBox, 'items-center', selected ? choiceOn : choiceOff)}>
        <PlatformTile conn={conn} />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-body font-semibold text-ink">{conn.displayName}</span>
          <span className="truncate text-caption text-muted">
            {platform.label}
            {conn.needsReconnect && ' · needs reconnect'}
          </span>
        </span>
        {selected && (
          <CheckCircle size={20} weight="fill" className="flex-none text-ink" aria-hidden="true" />
        )}
      </span>
    </label>
  );
}

function ModeCard({
  mode,
  selected,
  onSelect,
}: {
  mode: ScheduleMode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label className="relative block">
      <input
        type="radio"
        name="schedule-mode"
        className="peer sr-only"
        checked={selected}
        onChange={onSelect}
      />
      <span className={cn(choiceBox, 'h-full', selected ? choiceOn : choiceOff)}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-body font-semibold text-ink">{MODE_COPY[mode].title}</span>
          <span className="text-caption text-muted">{MODE_COPY[mode].description}</span>
        </span>
        {selected && (
          <CheckCircle size={20} weight="fill" className="flex-none text-ink" aria-hidden="true" />
        )}
      </span>
    </label>
  );
}

function MediaThumb({ item, onRemove }: { item: MediaItem; onRemove: () => void }) {
  const { ref, name } = item;
  return (
    <li className="relative">
      {ref.kind === 'image' && ref.url ? (
        <img
          src={ref.url}
          alt={name}
          className="h-20 w-20 rounded-sm border border-hairline object-cover"
        />
      ) : (
        <span className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-sm border border-hairline bg-surface-soft px-1 text-center">
          {ref.kind === 'video' ? (
            <PlayCircle size={24} className="text-muted" aria-hidden="true" />
          ) : (
            <ImageIcon size={24} className="text-muted" aria-hidden="true" />
          )}
          <span className="w-full truncate text-micro font-semibold text-ink">
            {ref.kind === 'video' ? 'Video' : 'Image'}
          </span>
          <span className="w-full truncate text-micro text-muted">{name}</span>
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="absolute -right-2 -top-2 grid h-7 w-7 place-items-center rounded-full border border-hairline bg-canvas text-ink shadow-1 hover:bg-surface-soft"
      >
        <CloseIcon size={14} weight="bold" />
      </button>
    </li>
  );
}

/** Neutral post card: not an imitation of any network, just what will go out and when. */
function Preview({
  accounts,
  caption,
  firstMedia,
  mediaCount,
  when,
}: {
  accounts: ConnectionView[];
  caption: string;
  firstMedia: MediaItem | undefined;
  mediaCount: number;
  when: string;
}) {
  const first = accounts[0];
  const platform = first
    ? platformMeta({ identifier: first.provider, displayName: first.provider })
    : null;
  return (
    <section aria-labelledby="preview-title" className="min-w-0">
      <h2 id="preview-title" className="mb-3 text-base font-semibold text-ink">
        Preview
      </h2>
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 p-4">
          {first ? (
            <PlatformTile conn={first} />
          ) : (
            <span
              className="grid h-9 w-9 flex-none place-items-center rounded-sm bg-surface-strong text-muted"
              aria-hidden="true"
            >
              <Plugs size={20} />
            </span>
          )}
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-body font-semibold text-ink">
              {first ? first.displayName : 'No account selected'}
            </span>
            <span className="truncate text-caption text-muted">
              {platform ? platform.label : 'Select an account to post as'}
              {accounts.length > 1 && ` · +${plural(accounts.length - 1, 'more account')}`}
            </span>
          </div>
        </div>

        <p
          className={cn(
            'whitespace-pre-wrap break-words px-4 pb-4 text-body',
            caption ? 'text-body-ink' : 'text-muted',
          )}
        >
          {caption || 'Your caption will appear here.'}
        </p>

        {firstMedia &&
          (firstMedia.ref.kind === 'image' && firstMedia.ref.url ? (
            <img
              src={firstMedia.ref.url}
              alt={`Preview of ${firstMedia.name}`}
              className="aspect-cover w-full object-cover"
            />
          ) : (
            <div className="flex aspect-cover w-full flex-col items-center justify-center gap-1 bg-surface-strong text-muted">
              {firstMedia.ref.kind === 'video' ? (
                <PlayCircle size={36} aria-hidden="true" />
              ) : (
                <ImageIcon size={36} aria-hidden="true" />
              )}
              <span className="max-w-full truncate px-4 text-caption font-medium">
                {firstMedia.ref.kind === 'video' ? 'Video' : 'Image'}: {firstMedia.name}
              </span>
            </div>
          ))}
        {mediaCount > 1 && (
          <p className="px-4 pt-3 text-caption text-muted">
            +{plural(mediaCount - 1, 'more media item')}
          </p>
        )}

        <p className="flex items-start gap-2 border-t border-hairline-soft p-4 text-caption text-muted">
          <Clock size={16} className="mt-0.5 flex-none" aria-hidden="true" />
          <span>{when}</span>
        </p>
      </Card>
    </section>
  );
}

export function Composer() {
  const { me } = useAuth();
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

  const [uploading, setUploading] = useState(0);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [attempted, setAttempted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const outcomeHeading = useRef<HTMLHeadingElement>(null);

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
  const queueName = queues.find((q) => q.id === queueId)?.name;
  const atError = errors.at && (attempted || at !== '') ? errors.at : undefined;
  const accountsError = attempted ? errors.accounts : undefined;
  const queueError = attempted ? errors.queue : undefined;
  const mediaFull = media.length + uploading >= MEDIA_MAX;

  const toggleAccount = (id: string) =>
    setConnectionIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

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

  const header = (
    <PageHeader
      title="Composer"
      subtitle={
        client
          ? `Posting as ${client.name}. Write once, then save, schedule, or queue it.`
          : 'Write once, then save, schedule, or queue it.'
      }
    />
  );

  if (load.state === 'loading') {
    return (
      <div>
        {header}
        <p className="text-body text-muted" role="status">
          Loading accounts…
        </p>
      </div>
    );
  }
  if (load.state === 'error') {
    return (
      <div>
        {header}
        <ErrorState
          title="Could not load the composer"
          message={load.message}
          onRetry={() => void fetchAccounts()}
        />
      </div>
    );
  }
  if (conns.length === 0) {
    return (
      <div>
        {header}
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
  }
  if (outcome) {
    return (
      <div>
        {header}
        <Card className="p-6">
          <CheckCircle size={32} weight="fill" className="text-status-ok" aria-hidden="true" />
          <h2
            ref={outcomeHeading}
            tabIndex={-1}
            className="mt-3 text-base font-semibold text-ink focus:outline-none"
          >
            {outcome.message}
          </h2>
          {outcome.statuses && (
            <p className="mt-1 flex items-center gap-1.5 text-body text-muted">
              {outcome.failed && (
                <WarningCircle size={18} className="text-status-bad" aria-hidden="true" />
              )}
              Status: {outcome.statuses}
            </p>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/calendar">
                <CalendarBlank size={18} />
                View calendar
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/content">View content</Link>
            </Button>
            <Button onClick={reset}>Create another</Button>
          </div>
        </Card>
      </div>
    );
  }

  const over = caption.length > CAPTION_MAX;
  const accountsErrorId = 'accounts-error';
  const captionErrorId = 'caption-error';
  const atErrorId = 'at-error';
  const queueErrorId = 'queue-error';
  const mediaErrorId = 'media-error';
  const queueSlotId = 'queue-slot';

  return (
    <div>
      {header}
      <div className="grid gap-6 lg:grid-cols-composer lg:items-start">
        <div className="min-w-0 space-y-6">
          <Section
            title="Post to"
            fieldset
            hint="Choose one or more of this client's connected accounts."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {conns.map((c) => (
                <AccountChip
                  key={c.id}
                  conn={c}
                  selected={connectionIds.includes(c.id)}
                  onToggle={() => toggleAccount(c.id)}
                  describedBy={accountsError ? accountsErrorId : undefined}
                />
              ))}
            </div>
            {accountsError && <FieldError id={accountsErrorId}>{accountsError}</FieldError>}
          </Section>

          <Section title="Caption">
            <Label htmlFor="caption" className="sr-only">
              Caption
            </Label>
            <Textarea
              id="caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Write something…"
              rows={6}
              aria-invalid={over}
              aria-describedby={cn('caption-count', over && captionErrorId)}
            />
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {over && errors.caption && (
                  <FieldError id={captionErrorId}>{errors.caption}</FieldError>
                )}
              </div>
              <p
                id="caption-count"
                className={cn(
                  'tnum text-caption',
                  over ? 'font-semibold text-error' : 'text-muted',
                )}
              >
                {caption.length} / {CAPTION_MAX}
              </p>
            </div>
          </Section>

          <Section
            title="Media"
            hint={`Photos and videos, up to ${MEDIA_MAX}. ${media.length} of ${MEDIA_MAX} attached.`}
          >
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
                'rounded-md border border-dashed p-4 text-center transition-colors',
                dragging ? 'border-ink bg-surface-soft' : 'border-hairline-strong',
              )}
            >
              <Button
                type="button"
                variant="outline"
                disabled={mediaFull}
                onClick={() => fileInput.current?.click()}
                aria-describedby={mediaError ? mediaErrorId : undefined}
              >
                <ImageIcon size={18} />
                {uploading > 0 ? 'Uploading…' : 'Add photos or videos'}
              </Button>
              <p
                className="mt-2 text-caption text-muted"
                role={uploading > 0 ? 'status' : undefined}
              >
                {uploading > 0
                  ? `Uploading ${plural(uploading, 'file')}…`
                  : mediaFull
                    ? `Maximum of ${MEDIA_MAX} reached. Remove one to add another.`
                    : 'Click to choose, or drop files here.'}
              </p>
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
            {media.length > 0 && (
              <ul className="flex flex-wrap gap-3 pt-1" aria-label="Attached media">
                {media.map((item) => (
                  <MediaThumb
                    key={item.ref.mediaId}
                    item={item}
                    onRemove={() =>
                      setMedia((prev) => prev.filter((m) => m.ref.mediaId !== item.ref.mediaId))
                    }
                  />
                ))}
              </ul>
            )}
          </Section>

          <Section title="When to post" fieldset>
            <div className="grid gap-2 sm:grid-cols-2">
              {SCHEDULE_MODES.map((m) => (
                <ModeCard key={m} mode={m} selected={mode === m} onSelect={() => setMode(m)} />
              ))}
            </div>

            {mode === 'at' && (
              <div className="space-y-1.5 pt-2">
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
              <div className="space-y-1.5 pt-2">
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
                  <p className="text-body text-muted">This client has no queues yet.</p>
                )}
                {/* A live region, so changing the queue announces its slot. */}
                <p id={queueSlotId} role="status" className="tnum text-caption text-muted">
                  {nextSlot && nextSlotText(nextSlot)}
                </p>
                {queueError && <FieldError id={queueErrorId}>{queueError}</FieldError>}
              </div>
            )}
          </Section>

          {error && (
            <ErrorState title="Could not create the post" message={error} className="py-6" />
          )}
          <Button className="w-full sm:w-auto" disabled={busy || uploading > 0} onClick={onSubmit}>
            {busy ? busyLabel(mode) : submitLabel(mode, targets.length)}
          </Button>
        </div>

        <div className="min-w-0 lg:sticky lg:top-6">
          <Preview
            accounts={targets}
            caption={caption}
            firstMedia={media[0]}
            mediaCount={media.length}
            when={scheduleSummary(mode, at, queueName, nextSlot)}
          />
        </div>
      </div>

      {confirming && (
        <Modal title="Publish now?" onClose={closeConfirm}>
          <p className="text-body text-body-ink">
            This sends the post immediately, for real, to {plural(targets.length, 'account')}:
          </p>
          <ul className="mt-3 space-y-2">
            {targets.map((c) => (
              <li key={c.id} className="flex items-center gap-3">
                <PlatformTile conn={c} size="sm" />
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-body font-semibold text-ink">{c.displayName}</span>
                  <span className="truncate text-caption text-muted">
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
    </div>
  );
}
