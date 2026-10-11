import { describe, expect, it } from 'vitest';
import { groupProviders, platformMeta } from './platforms';

const p = (identifier: string) => ({ identifier, displayName: identifier });

describe('groupProviders', () => {
  it('lists platforms under what they are for, in a fixed group order', () => {
    const groups = groupProviders([p('wordpress'), p('facebook'), p('instagram')]);
    expect(groups.map((g) => [g.label, g.providers.map((x) => x.identifier)])).toEqual([
      ['Social', ['facebook', 'instagram']],
      ['Blogs', ['wordpress']],
    ]);
  });

  it('keeps an unknown (dev) provider, under Social, and drops empty groups', () => {
    const groups = groupProviders([p('fake')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: 'social', providers: [p('fake')] });
    expect(groupProviders([])).toEqual([]);
  });

  it('never loses a provider', () => {
    const all = ['facebook', 'wordpress', 'fake', 'youtube', 'gmb'].map(p);
    expect(groupProviders(all).flatMap((g) => g.providers)).toHaveLength(all.length);
  });
});

describe('platformMeta', () => {
  it('gives an unknown provider its own display name and a neutral tile', () => {
    expect(platformMeta({ identifier: 'fake', displayName: 'Fake Provider' })).toMatchObject({
      label: 'Fake Provider',
      brand: 'bg-muted',
    });
  });
});
