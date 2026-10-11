import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodError } from 'zod';
import {
  AnalyticsQueryError,
  ConnectionNotFoundError,
  ImportNotSupportedError,
  PostStateError,
  ProviderBadRequestError,
  QueueInactiveError,
  QueueNotFoundError,
} from '@meegrow-social/core';

/**
 * What a failed tool call reports. Mirrors the REST status the same failure gets in `server.ts`:
 * `not_found` = 404, `invalid_state` = 409, `invalid_request` = 400, `internal_error` = 500.
 */
export type ToolErrorCode = 'not_found' | 'invalid_state' | 'invalid_request' | 'internal_error';

/** Thrown by a handler for a failure core reports as a value (`null` / `false`) instead of throwing. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string): ToolError =>
  new ToolError('not_found', `${what} not found`);

function fail(code: ToolErrorCode, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
  };
}

function failFrom(err: unknown): CallToolResult {
  if (err instanceof ToolError) return fail(err.code, err.message);
  if (err instanceof QueueNotFoundError) return fail('not_found', err.message);
  if (err instanceof ConnectionNotFoundError) return fail('not_found', err.message);
  if (err instanceof PostStateError) return fail('invalid_state', err.message);
  if (err instanceof QueueInactiveError) return fail('invalid_request', err.message);
  if (err instanceof ProviderBadRequestError) return fail('invalid_request', err.message);
  if (err instanceof ImportNotSupportedError) return fail('invalid_request', err.message);
  if (err instanceof AnalyticsQueryError) return fail('invalid_request', err.message);
  if (err instanceof ZodError) {
    return fail(
      'invalid_request',
      err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
    );
  }
  return fail('internal_error', err instanceof Error ? err.message : String(err));
}

/**
 * Runs a handler body and serializes its result. Every failure comes back as an MCP tool error
 * (`isError: true`) the calling agent can read and act on — never a thrown JSON-RPC error.
 */
export async function respond(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await body()) }] };
  } catch (err) {
    return failFrom(err);
  }
}

/** Same bound as the REST `Idempotency-Key` header (D2). */
export const idempotencyKey = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe(
    'Retry-safety key. A second call with the same key returns the posts the first call created ' +
      'and writes nothing. Always set it when the call may be retried after a timeout.',
  );

/** Reads workspace data only. */
export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** Changes data inside the workspace; nothing leaves it. */
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Can put content on a real social account. */
export const PUBLISH: ToolAnnotations = { ...WRITE, openWorldHint: true };
