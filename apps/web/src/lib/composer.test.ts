import { describe, expect, it } from 'vitest';
import { createPostInput } from '@meegrow-social/contracts';
import type { ConnectionView, MediaRef, QueueView } from '@meegrow-social/contracts';
import {
  CAPTION_MAX,
  MEDIA_MAX,
  buildCreatePostInput,
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
  validateScheduleAt,
  type ComposerForm,
} from './composer';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const conn = (n: number, provider: 'facebook' | 'instagram' | 'gmb'): ConnectionView => ({
  id: id(n),
  provider,
  externalId: `ext-${n}`,
  displayName: `Account ${n}`,
  needsReconnect: false,
  expiresAt: null,
  expiresInDays: null,
  health: 'ok',
  createdAt: new Date('2026-01-01T00:00:00Z'),
});

const queue = (n: number): QueueView => ({
  id: id(n),
  name: `Queue ${n}`,
  timezone: 'UTC',
  slots: [],
  active: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
});

const conns = [conn(1, 'facebook'), conn(2, 'instagram'), conn(3, 'gmb')];
const queues = [queue(10), queue(11)];
const NOW = new Date(2026, 9, 10, 12, 0, 0); // local time: 10 Oct 2026, 12:00

const form = (over: Partial<ComposerForm> = {}): ComposerForm => ({
  caption: 'Hello',
  media: [],
  connectionIds: [id(1)],
  mode: 'draft',
  at: '',
  queueId: id(10),
  ...over,
});

describe('contract limits', () => {
  // The contract exports no constants, so pin ours against the real schema.
  const base = { variants: [{ connectionId: id(1), provider: 'facebook' }] };
  const media = (n: number): MediaRef[] =>
    Array.from({ length: n }, (_, i) => ({ mediaId: id(100 + i), kind: 'image' as const }));

  it('CAPTION_MAX is the largest caption createPostInput accepts', () => {
    expect(createPostInput.safeParse({ ...base, caption: 'a'.repeat(CAPTION_MAX) }).success).toBe(
      true,
    );
    expect(
      createPostInput.safeParse({ ...base, caption: 'a'.repeat(CAPTION_MAX + 1) }).success,
    ).toBe(false);
  });

  it('MEDIA_MAX is the most media createPostInput accepts', () => {
    expect(createPostInput.safeParse({ ...base, media: media(MEDIA_MAX) }).success).toBe(true);
    expect(createPostInput.safeParse({ ...base, media: media(MEDIA_MAX + 1) }).success).toBe(false);
  });
});

describe('submitLabel', () => {
  it('names the mode for one account', () => {
    expect(submitLabel('draft', 1)).toBe('Save draft');
    expect(submitLabel('now', 1)).toBe('Publish now');
    expect(submitLabel('at', 1)).toBe('Schedule');
    expect(submitLabel('queue', 1)).toBe('Add to queue');
  });

  it('adds the account count once there is more than one', () => {
    expect(submitLabel('now', 3)).toBe('Publish now to 3 accounts');
    expect(submitLabel('draft', 2)).toBe('Save draft to 2 accounts');
  });

  it('stays plain with no accounts selected', () => {
    expect(submitLabel('at', 0)).toBe('Schedule');
  });
});

describe('validateScheduleAt', () => {
  it('requires a value', () => {
    expect(validateScheduleAt('', NOW)).toBe('Pick a date and time.');
  });

  it('rejects an unparseable value', () => {
    expect(validateScheduleAt('not-a-date', NOW)).toBe('Enter a valid date and time.');
  });

  it('rejects a past time and the current instant', () => {
    expect(validateScheduleAt('2026-10-10T11:59', NOW)).toBe('Pick a time in the future.');
    expect(validateScheduleAt('2026-10-10T12:00', NOW)).toBe('Pick a time in the future.');
  });

  it('accepts a future time', () => {
    expect(validateScheduleAt('2026-10-10T12:01', NOW)).toBeNull();
  });
});

describe('toLocalInputValue', () => {
  it('formats local time to the minute with zero padding', () => {
    expect(toLocalInputValue(new Date(2026, 0, 5, 3, 7, 59))).toBe('2026-01-05T03:07');
  });

  it('round-trips through validateScheduleAt', () => {
    expect(
      validateScheduleAt(toLocalInputValue(new Date(NOW.getTime() + 3600_000)), NOW),
    ).toBeNull();
  });
});

describe('validateForm', () => {
  it('passes a draft with one account', () => {
    expect(hasErrors(validateForm(form(), queues, NOW))).toBe(false);
  });

  it('requires an account', () => {
    expect(validateForm(form({ connectionIds: [] }), queues, NOW).accounts).toBe(
      'Select at least one account.',
    );
  });

  it('allows an empty caption, as the previous Composer did', () => {
    expect(hasErrors(validateForm(form({ caption: '' }), queues, NOW))).toBe(false);
  });

  it('flags a caption over the limit with how far over', () => {
    const errors = validateForm(form({ caption: 'a'.repeat(CAPTION_MAX + 3) }), queues, NOW);
    expect(errors.caption).toContain('3 over');
    expect(hasErrors(validateForm(form({ caption: 'a'.repeat(CAPTION_MAX) }), queues, NOW))).toBe(
      false,
    );
  });

  it('only checks the time in "at" mode', () => {
    expect(validateForm(form({ mode: 'draft', at: '' }), queues, NOW).at).toBeUndefined();
    expect(validateForm(form({ mode: 'now', at: '2020-01-01T00:00' }), queues, NOW).at).toBe(
      undefined,
    );
    expect(validateForm(form({ mode: 'at', at: '' }), queues, NOW).at).toBeDefined();
    expect(validateForm(form({ mode: 'at', at: '2020-01-01T00:00' }), queues, NOW).at).toBe(
      'Pick a time in the future.',
    );
  });

  it('only checks the queue in "queue" mode, and it must be one of the client queues', () => {
    expect(validateForm(form({ mode: 'draft', queueId: '' }), queues, NOW).queue).toBeUndefined();
    expect(validateForm(form({ mode: 'queue', queueId: '' }), queues, NOW).queue).toBe(
      'Pick a queue.',
    );
    expect(validateForm(form({ mode: 'queue', queueId: id(99) }), queues, NOW).queue).toBe(
      'Pick a queue.',
    );
    expect(
      validateForm(form({ mode: 'queue', queueId: id(11) }), queues, NOW).queue,
    ).toBeUndefined();
    expect(validateForm(form({ mode: 'queue' }), [], NOW).queue).toBe('Pick a queue.');
  });
});

describe('selectedConnections', () => {
  it('follows the connection list order, not the click order', () => {
    expect(selectedConnections(conns, [id(3), id(1)]).map((c) => c.id)).toEqual([id(1), id(3)]);
  });

  it('ignores ids that are no longer connected', () => {
    expect(selectedConnections(conns, [id(2), id(99)]).map((c) => c.id)).toEqual([id(2)]);
  });
});

describe('buildCreatePostInput', () => {
  it('sends one variant per selected account with its provider', () => {
    const input = buildCreatePostInput(form({ connectionIds: [id(3), id(1)] }), conns);
    expect(input.variants).toEqual([
      { connectionId: id(1), provider: 'facebook' },
      { connectionId: id(3), provider: 'gmb' },
    ]);
  });

  it('carries caption and media through', () => {
    const media: MediaRef[] = [{ mediaId: id(50), kind: 'image', url: 'https://x.test/a.jpg' }];
    const input = buildCreatePostInput(form({ caption: 'Line 1\nLine 2', media }), conns);
    expect(input.caption).toBe('Line 1\nLine 2');
    expect(input.media).toEqual(media);
  });

  it('maps each mode to its schedule', () => {
    expect(buildCreatePostInput(form({ mode: 'draft' }), conns).schedule).toEqual({
      type: 'draft',
    });
    expect(buildCreatePostInput(form({ mode: 'now' }), conns).schedule).toEqual({ type: 'now' });
    expect(buildCreatePostInput(form({ mode: 'queue', queueId: id(11) }), conns).schedule).toEqual({
      type: 'queue',
      queueId: id(11),
    });
    const at = buildCreatePostInput(form({ mode: 'at', at: '2026-10-12T09:30' }), conns).schedule;
    expect(at).toEqual({ type: 'at', publishAt: new Date(2026, 9, 12, 9, 30) });
  });

  it('produces a payload the contract accepts, for every mode', () => {
    for (const f of [
      form(),
      form({ mode: 'now', connectionIds: [id(1), id(2), id(3)] }),
      form({ mode: 'at', at: '2026-10-12T09:30' }),
      form({ mode: 'queue', queueId: id(10) }),
    ]) {
      expect(createPostInput.safeParse(buildCreatePostInput(f, conns)).success).toBe(true);
    }
  });

  it('refuses a form it cannot send', () => {
    expect(() => buildCreatePostInput(form({ connectionIds: [] }), conns)).toThrow();
    expect(() => buildCreatePostInput(form({ connectionIds: [id(99)] }), conns)).toThrow();
    expect(() => buildCreatePostInput(form({ mode: 'at', at: '' }), conns)).toThrow();
    expect(() => buildCreatePostInput(form({ mode: 'queue', queueId: '' }), conns)).toThrow();
  });
});

describe('scheduleSummary and outcomeMessage', () => {
  it('summarises each mode', () => {
    expect(scheduleSummary('draft', '', undefined)).toContain('draft');
    expect(scheduleSummary('now', '', undefined)).toContain('immediately');
    expect(scheduleSummary('at', '', undefined)).toBe('Pick a date and time.');
    expect(scheduleSummary('at', '2026-10-12T09:30', undefined)).toContain('Scheduled for');
    expect(scheduleSummary('queue', '', 'Weekday mornings')).toContain('Weekday mornings');
    expect(scheduleSummary('queue', '', undefined)).toBe('Pick a queue.');
  });

  it('puts the previewed slot in the queue summary', () => {
    const publishAt = new Date('2026-10-12T09:30:00.000Z');
    const when = publishAt.toLocaleString();
    expect(scheduleSummary('queue', '', 'Weekday mornings', { state: 'ready', publishAt })).toBe(
      `Next free slot in Weekday mornings: ${when}.`,
    );
    expect(scheduleSummary('queue', '', 'Weekday mornings', { state: 'none' })).toBe(
      'Weekday mornings has no free slot in the next 90 days.',
    );
    // Still loading, failed, or not fetched: the summary stays as it was without a preview.
    for (const slot of [{ state: 'loading' }, { state: 'error', message: 'x' }, null] as const) {
      expect(scheduleSummary('queue', '', 'Weekday mornings', slot)).toBe(
        'Next free slot in Weekday mornings.',
      );
    }
    expect(scheduleSummary('queue', '', undefined, { state: 'ready', publishAt })).toBe(
      'Pick a queue.',
    );
    expect(scheduleSummary('now', '', undefined, { state: 'ready', publishAt })).toContain(
      'immediately',
    );
  });

  it('names what happened and for how many accounts', () => {
    expect(outcomeMessage('draft', 1, {})).toBe('Saved as a draft for 1 account.');
    expect(outcomeMessage('now', 2, {})).toBe('Publishing now to 2 accounts.');
    expect(outcomeMessage('queue', 2, { queueName: 'Weekday mornings' })).toBe(
      'Added to Weekday mornings for 2 accounts.',
    );
    expect(outcomeMessage('at', 1, { at: '2026-10-12T09:30' })).toMatch(
      /^Scheduled for .+ on 1 account\.$/,
    );
  });
});

describe('postStatusSummary', () => {
  it('counts statuses', () => {
    expect(postStatusSummary([{ status: 'scheduled' }, { status: 'scheduled' }])).toBe(
      '2 scheduled',
    );
    expect(postStatusSummary([{ status: 'published' }, { status: 'failed' }])).toBe(
      '1 published, 1 failed',
    );
    expect(postStatusSummary([])).toBe('');
  });
});

describe('plural', () => {
  it('pluralises', () => {
    expect(plural(1, 'account')).toBe('1 account');
    expect(plural(2, 'account')).toBe('2 accounts');
  });
});

describe('next queue slot', () => {
  const slot = (publishAt: unknown) => ({ publishAt: publishAt as Date, localTime: '' });

  it('takes the first slot of the response', () => {
    // Dates arrive as ISO strings: the API client does not run responses through the Zod parsers.
    const next = nextSlotFromView({
      slots: [slot('2026-10-12T04:00:00.000Z'), slot('2026-10-13T04:00:00.000Z')],
    });
    expect(next).toEqual({ state: 'ready', publishAt: new Date('2026-10-12T04:00:00.000Z') });
  });

  it('reads an empty list or an unusable date as no free slot', () => {
    expect(nextSlotFromView({ slots: [] })).toEqual({ state: 'none' });
    expect(nextSlotFromView({ slots: [slot('not a date')] })).toEqual({ state: 'none' });
  });

  it('explains a failed preview by status', () => {
    expect(nextSlotError(400)).toContain('paused');
    expect(nextSlotError(404)).toContain('no longer exists');
    expect(nextSlotError(500)).toBe('Could not check the next slot.');
    expect(nextSlotError(undefined)).toBe('Could not check the next slot.');
  });

  it('words each state for the line under the queue picker', () => {
    const publishAt = new Date('2026-10-12T04:00:00.000Z');
    expect(nextSlotText({ state: 'loading' })).toBe('Checking the next slot…');
    expect(nextSlotText({ state: 'ready', publishAt })).toBe(
      `Next slot: ${publishAt.toLocaleString()}`,
    );
    expect(nextSlotText({ state: 'none' })).toBe('No free slot in the next 90 days.');
    expect(nextSlotText({ state: 'error', message: 'Nope.' })).toBe('Nope.');
  });
});
