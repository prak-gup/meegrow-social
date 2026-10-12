import { describe, expect, it } from 'vitest';
import { parseConnectCompletion } from './connectCompletion';

describe('connect completion wake-up signal', () => {
  it('returns only provider, outcome and time, dropping URL data and credentials', () => {
    expect(
      parseConnectCompletion({
        provider: 'youtube',
        outcome: 'success',
        time: 123,
        connectionId: 'private-id',
        token: 'secret',
        url: '?password=secret',
        error: 'private error',
      }),
    ).toEqual({ provider: 'youtube', outcome: 'success', time: 123 });
  });
  it('accepts failure and hyphenated provider identifiers', () => {
    expect(
      parseConnectCompletion({ provider: 'linkedin-page', outcome: 'failure', time: 123 }),
    ).toEqual({ provider: 'linkedin-page', outcome: 'failure', time: 123 });
  });
  it.each([
    null,
    {},
    { provider: 'youtube', outcome: 'choose_account', time: 123 },
    { provider: '?token=secret', outcome: 'success', time: 123 },
    { provider: 'youtube', outcome: 'success', time: NaN },
    { provider: 'youtube', outcome: 'success', time: 0 },
  ])('rejects malformed signals: %j', (value) => {
    expect(parseConnectCompletion(value)).toBeNull();
  });
});

import { vi, afterEach } from 'vitest';
import {
  announceConnectCompletion,
  subscribeConnectCompletion,
  CONNECT_COMPLETION_STORAGE_KEY,
} from './connectCompletion';
afterEach(() => vi.unstubAllGlobals());
describe('cross-tab delivery', () => {
  it('announces minimal signal over both transports', () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        postMessage = postMessage;
        close = close;
      },
    );
    vi.stubGlobal('window', { localStorage: { setItem } });
    announceConnectCompletion('youtube', 'success');
    expect(Object.keys(postMessage.mock.calls[0]![0])).toEqual(['provider', 'outcome', 'time']);
    expect(JSON.parse(setItem.mock.calls[0]![1])).toEqual(postMessage.mock.calls[0]![0]);
    expect(close).toHaveBeenCalledOnce();
  });
  it('uses storage when channels are unavailable and removes listener on cleanup', () => {
    let listener: ((e: { key: string; newValue: string }) => void) | undefined;
    const removeEventListener = vi.fn();
    const receive = vi.fn();
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          throw new Error('disabled');
        }
      },
    );
    vi.stubGlobal('window', {
      addEventListener: (_: string, cb: typeof listener) => {
        listener = cb;
      },
      removeEventListener,
    });
    const cleanup = subscribeConnectCompletion(receive);
    const e = {
      key: CONNECT_COMPLETION_STORAGE_KEY,
      newValue: JSON.stringify({ provider: 'youtube', outcome: 'success', time: 123 }),
    };
    listener!(e);
    listener!(e);
    expect(receive).toHaveBeenCalledOnce();
    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith('storage', listener);
  });
});
