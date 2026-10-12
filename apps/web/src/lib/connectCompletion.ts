/** A wake-up signal only. Never carry callback URLs, account IDs, credentials or errors here. */
export const CONNECT_COMPLETION_CHANNEL = 'meegrow-social-connect-completion';
export const CONNECT_COMPLETION_STORAGE_KEY = 'mg_connect_completion';
export interface ConnectCompletion {
  provider: string;
  outcome: 'success' | 'failure';
  time: number;
}

export function parseConnectCompletion(value: unknown): ConnectCompletion | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Partial<ConnectCompletion>;
  if (
    typeof p.provider !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(p.provider) ||
    (p.outcome !== 'success' && p.outcome !== 'failure') ||
    typeof p.time !== 'number' ||
    !Number.isFinite(p.time) ||
    p.time <= 0
  )
    return null;
  return { provider: p.provider, outcome: p.outcome, time: p.time };
}

export function announceConnectCompletion(
  provider: string,
  outcome: ConnectCompletion['outcome'],
): void {
  const signal = parseConnectCompletion({ provider, outcome, time: Date.now() });
  if (!signal) return;
  try {
    const channel = new BroadcastChannel(CONNECT_COMPLETION_CHANNEL);
    channel.postMessage(signal);
    channel.close();
  } catch {
    /* Older browsers and privacy settings can disable channels. */
  }
  try {
    window.localStorage.setItem(CONNECT_COMPLETION_STORAGE_KEY, JSON.stringify(signal));
  } catch {
    /* Focus refresh and pending polling still work when storage is blocked. */
  }
}

export function subscribeConnectCompletion(
  onCompletion: (signal: ConnectCompletion) => void,
): () => void {
  const seen = new Set<string>();
  const receive = (value: unknown) => {
    const signal = parseConnectCompletion(value);
    if (!signal) return;
    const key = `${signal.provider}:${signal.outcome}:${signal.time}`;
    if (seen.has(key)) return;
    seen.add(key);
    onCompletion(signal);
  };
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(CONNECT_COMPLETION_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => receive(event.data);
  } catch {
    /* The storage event is the fallback. */
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== CONNECT_COMPLETION_STORAGE_KEY || !event.newValue) return;
    try {
      receive(JSON.parse(event.newValue));
    } catch {
      /* Ignore unrelated/malformed storage. */
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    channel?.close();
    window.removeEventListener('storage', onStorage);
  };
}
