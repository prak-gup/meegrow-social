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

export type ProviderError = ProviderAuthError | ProviderBadRequestError | ProviderTransientError;

export function isRetryable(err: unknown): boolean {
  return err instanceof ProviderTransientError;
}
