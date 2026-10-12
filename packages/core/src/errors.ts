/**
 * Provider error taxonomy (adapted from Postiz). The scheduler branches on these:
 * - ProviderAuthError       → mark connection needs_reconnect, DO NOT retry
 * - ProviderBadRequestError → fail the post permanently, DO NOT retry
 * - ProviderTransientError  → retry with backoff
 */
export class ProviderAuthError extends Error {
  readonly kind = 'auth' as const;
}
export class ProviderBadRequestError extends Error {
  readonly kind = 'bad_request' as const;
}
export class ProviderTransientError extends Error {
  readonly kind = 'transient' as const;
}
/**
 * The platform is throttling this app. Still transient, but publishing pauses without spending an ordinary attempt;
 * a sweep that reads many things must stop asking rather than try the next one.
 */
export const RATE_LIMIT_MIN_MS = 30_000;
export const RATE_LIMIT_MAX_MS = 6 * 60 * 60_000;

export function boundedRateLimitDelay(ms: number): number {
  return Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_MIN_MS, Math.ceil(ms)));
}

export class ProviderRateLimitError extends ProviderTransientError {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number | null) {
    super(message);
    this.retryAfterMs =
      retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? boundedRateLimitDelay(retryAfterMs)
        : undefined;
  }

  delayForPause(pauses: number): number {
    return (
      this.retryAfterMs ??
      boundedRateLimitDelay(120_000 * 2 ** Math.min(16, Math.max(0, pauses - 1)))
    );
  }
}

export type ProviderError = ProviderAuthError | ProviderBadRequestError | ProviderTransientError;

export function isRetryable(err: unknown): boolean {
  return err instanceof ProviderTransientError;
}

/**
 * Why a connect flow's callback did not end in a connection. A fixed vocabulary, because for a
 * provider whose callback carries a credential the API answers with a redirect and the reason has
 * to travel in that redirect's query string — where free text would be an open invitation to put
 * words in this app's mouth. `connectFailureMessage` is the only wording a person ever reads.
 */
export const CONNECT_FAILURE_MESSAGES = {
  invalid_state: 'this connection attempt is unknown or was already used',
  expired: 'this connection attempt expired before it was finished',
  different_browser:
    'this approval was opened in a different browser from the one the connection was started in',
  invite_closed: 'this invite link is no longer valid',
  denied: 'access was not approved on the platform’s screen',
  incomplete: 'the platform did not send back everything needed to connect',
  site_mismatch: 'the approval came back from a different site than the one being connected',
  credentials_rejected:
    'the site did not accept the password it had just issued — a security plugin or the web server may be blocking API logins',
  insufficient_role:
    'that WordPress user is not allowed to publish posts — approve with an Author, Editor or Administrator account',
  site_unreachable: 'the site could not be reached to confirm the connection',
  unavailable: 'the site does not offer this kind of connection',
  // Username-and-password connect (XML-RPC). Never WordPress's own text, never what was typed.
  login_rejected: 'the site did not accept that username and password',
  role_cannot_publish:
    'that WordPress user cannot publish posts — use a user with the Author or Editor role',
  xmlrpc_disabled:
    'XML-RPC is switched off on this site, so it cannot be connected with a username and password',
  xmlrpc_blocked:
    'a firewall or security plugin on the site is blocking XML-RPC requests from this server',
  xmlrpc_not_found: 'no xmlrpc.php was found at that address',
  site_moved:
    'the site redirected the request to another address, so nothing was sent on — check the site again with the address it redirects to',
  check_expired: 'this site check is no longer valid — check the site again',
  failed: 'the connection could not be completed',
} as const;

export type ConnectFailureCode = keyof typeof CONNECT_FAILURE_MESSAGES;

/** A connect flow that ended without a connection, for a reason a person can act on. */
export class ConnectError extends Error {
  constructor(
    readonly code: ConnectFailureCode,
    message: string = CONNECT_FAILURE_MESSAGES[code],
  ) {
    super(message);
  }
}

/** The code to report for anything a connect callback threw. Never derived from its text. */
export function connectFailureCode(err: unknown): ConnectFailureCode {
  return err instanceof ConnectError ? err.code : 'failed';
}

/** The sentence for a code — including one read back out of a URL, which may be anything. */
export function connectFailureMessage(code: unknown): string {
  return typeof code === 'string' && Object.hasOwn(CONNECT_FAILURE_MESSAGES, code)
    ? CONNECT_FAILURE_MESSAGES[code as ConnectFailureCode]
    : CONNECT_FAILURE_MESSAGES.failed;
}
