import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('keeps a custom font size next to a text colour', () => {
    for (const size of ['micro', 'caption', 'body', 'wordmark', 'title']) {
      expect(cn(`text-${size}`, 'text-muted')).toBe(`text-${size} text-muted`);
      expect(cn(`text-${size} text-ink`, 'text-status-bad')).toBe(`text-${size} text-status-bad`);
    }
  });

  it('still lets a later font size replace an earlier one, custom or stock', () => {
    expect(cn('text-caption', 'text-micro')).toBe('text-micro');
    expect(cn('text-sm', 'text-caption')).toBe('text-caption');
    expect(cn('text-caption', 'text-lg')).toBe('text-lg');
  });

  it('still lets a later colour replace an earlier one', () => {
    expect(cn('text-muted', 'text-ink')).toBe('text-ink');
  });
});
