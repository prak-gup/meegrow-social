import { describe, expect, it } from 'vitest';
import { postOptions, type PostView } from '@meegrow-social/contracts';
import {
  buildCreatePostInput,
  buildValidationInput,
  isDirty,
  validateForm,
  visibleAccountProblems,
} from './composer';
import {
  emptyYouTube,
  utf8Bytes,
  youtubeTagLength,
  youtubeOptions,
  youtubeTags,
  youtubeFileError,
  youtubeVisibilitySummary,
} from './youtube';

// Documentation-built values only; these fixtures have never contacted Google.
describe('YouTube composer', () => {
  it('counts UTF-8 bytes and Google tag separators and quotes', () => {
    expect(utf8Bytes('é🙂')).toBe(6);
    expect(youtubeTags(' one, two words, ,three ')).toEqual(['one', 'two words', 'three']);
    expect(youtubeTagLength('one,two words,three')).toBe(21);
    expect(
      postOptions.safeParse({ kind: 'youtube', title: 'Fixture', description: 'é'.repeat(2501) })
        .success,
    ).toBe(false);
    expect(
      postOptions.safeParse({ kind: 'youtube', title: 'Fixture', description: 'é'.repeat(2500) })
        .success,
    ).toBe(true);
  });
  it('checks video formats and the storage cap', () => {
    expect(youtubeFileError({ name: 'fixture.mp4', type: 'video/mp4', size: 1 })).toBeNull();
    expect(
      youtubeFileError({ name: 'fixture.unlisted-extension', type: 'video/custom', size: 1 }),
    ).toBeNull();
    expect(youtubeFileError({ name: 'fixture.mp4', type: 'video/mp4', size: 0 })).toContain(
      'non-empty',
    );
    expect(youtubeFileError({ name: 'fixture.png', type: 'image/png', size: 1 })).toContain(
      'video',
    );
    expect(
      youtubeFileError({ name: 'fixture.mp4', type: 'video/mp4', size: 1200 * 1024 * 1024 + 1 }),
    ).toContain('1200 MiB');
  });
  it('shows returned visibility instead of the requested visibility', () => {
    const post = {
      provider: 'youtube',
      status: 'published',
      options: {
        kind: 'youtube',
        title: 'Fixture video',
        privacyStatus: 'public',
        remote: { privacyStatus: 'private' },
      },
    } as PostView;
    expect(youtubeVisibilitySummary([post])).toEqual(['YouTube visibility: private']);
    expect(
      youtubeVisibilitySummary([
        { ...post, options: { ...post.options, remote: undefined } } as PostView,
      ]),
    ).toEqual(['YouTube visibility: awaiting YouTube confirmation']);
  });
  it('keeps queued visibility unconfirmed and filters other platforms', () => {
    const queued = {
      provider: 'youtube',
      status: 'queued',
      options: { kind: 'youtube', title: 'Fixture video', privacyStatus: 'public' },
    } as PostView;
    const facebook = { provider: 'facebook', status: 'published' } as PostView;
    expect(youtubeVisibilitySummary([queued, facebook])).toEqual([
      'YouTube visibility will appear after publishing. You can also check Content.',
    ]);
    expect(youtubeVisibilitySummary([facebook])).toEqual([]);
  });
  it('follows caption until description is separately edited', () => {
    const youtube = { ...emptyYouTube(), title: 'Fixture video', madeForKids: 'no' as const };
    expect(youtubeOptions(youtube).description).toBeUndefined();
    expect(youtubeOptions({ ...youtube, description: '' }).description).toBe('');
    expect(youtubeOptions(youtube).madeForKids).toBe(false);
    expect(youtubeOptions({ ...youtube, madeForKids: 'yes' }).madeForKids).toBe(true);
  });
  it('requires an audience choice and exactly one video only for selected YouTube', () => {
    const connection = {
      id: 'yt',
      provider: 'youtube',
      displayName: 'Fixture channel',
    } as Parameters<typeof buildCreatePostInput>[1][number];
    const form = {
      caption: '',
      media: [],
      youtube: emptyYouTube(),
      connectionIds: ['yt'],
      mode: 'draft' as const,
      at: '',
      queueId: '',
    };
    expect(validateForm(form, [], new Date(), [connection])).toMatchObject({
      youtube: 'Choose whether the video is made for kids.',
      media: 'YouTube needs exactly one video file.',
    });
    expect(
      validateForm({ ...form, connectionIds: [] }, [], new Date(), [connection]).youtube,
    ).toBeUndefined();
    const issue = {
      connectionId: 'yt',
      code: 'invalid_request' as const,
      message: 'Title required',
    };
    expect(visibleAccountProblems([connection], [issue], ['yt'], false, false).size).toBe(0);
    expect(visibleAccountProblems([connection], [issue], [], true, false).size).toBe(0);
    expect(
      visibleAccountProblems([connection], [issue], ['yt'], true, false).get('yt')?.reason,
    ).toBe('Title required');
  });
  it('sends options on create and the existing validation path only to YouTube', () => {
    const youtube = { ...emptyYouTube(), title: 'Fixture video', madeForKids: 'no' as const };
    const form = {
      caption: 'Caption',
      media: [],
      youtube,
      connectionIds: ['yt', 'social'],
      mode: 'draft' as const,
      at: '',
      queueId: '',
    };
    const connections = [
      { id: 'yt', provider: 'youtube' },
      { id: 'social', provider: 'facebook' },
    ] as Parameters<typeof buildCreatePostInput>[1];
    const input = buildCreatePostInput(form, connections);
    expect(input.variants[0]?.options).toEqual(youtubeOptions(youtube));
    expect(input.variants[1]?.options).toBeUndefined();
    expect(buildValidationInput(form, connections).variants).toEqual(input.variants);
    expect(isDirty({ caption: '', media: [], youtube: emptyYouTube() })).toBe(false);
    expect(isDirty({ caption: '', media: [], youtube })).toBe(true);
  });
});
