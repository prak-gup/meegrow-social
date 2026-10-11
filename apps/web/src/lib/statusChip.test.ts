import { describe, expect, it } from 'vitest';
import { CHIP, clientChip, connectionChip, postChip } from './statusChip';

describe('connectionChip', () => {
  it('reads health straight through', () => {
    expect(connectionChip('healthy', 40)).toBe('healthy');
    expect(connectionChip('healthy', null)).toBe('healthy');
    expect(connectionChip('expiring', 5)).toBe('expiring');
    expect(connectionChip('needs_reconnect', 5)).toBe('needs_reconnect');
  });
  it('treats a lapsed token as needing a reconnect even if health says otherwise', () => {
    expect(connectionChip('healthy', -1)).toBe('needs_reconnect');
    expect(connectionChip('expiring', -3)).toBe('needs_reconnect');
  });
  it('does not treat an expiry of today as lapsed', () => {
    expect(connectionChip('expiring', 0)).toBe('expiring');
  });
});

describe('clientChip', () => {
  it('maps the rollup health and names the reason', () => {
    expect(clientChip('ok', 0)).toEqual({ status: 'healthy', label: 'Healthy' });
    expect(clientChip('bad', 0)).toEqual({ status: 'needs_reconnect', label: 'Needs reconnect' });
    expect(clientChip('warn', 3)).toEqual({ status: 'failed', label: '3 failed' });
    expect(clientChip('warn', 0)).toEqual({ status: 'expiring', label: 'Queue empty' });
  });
});

describe('chip vocabulary', () => {
  it('has words for every status, so colour never carries it alone', () => {
    for (const { label } of Object.values(CHIP)) expect(label.length).toBeGreaterThan(2);
  });
  it('keeps post statuses identical to their chips', () => {
    expect(postChip('scheduled')).toBe('scheduled');
    expect(postChip('failed')).toBe('failed');
  });
});
