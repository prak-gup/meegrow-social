export interface StoredObject {
  /** Backend-relative key (disk-relative path or S3 object key). Persisted on media.s3Key. */
  key: string;
  /** Publicly reachable URL — required by IG/GBP at publish time (PRD F3.3). */
  url: string;
}

export interface PutObjectInput {
  workspaceId: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

/**
 * Storage driver port (AX-PRD §1: "S3 + public URLs"). Disk impl backs dev + tests (no AWS in CI);
 * S3 impl backs prod. Selected by env in `./index.ts` — nothing outside this folder should
 * construct a driver directly except via `getStorageDriver()`.
 */
export interface StorageDriver {
  readonly kind: 'disk' | 's3';
  put(input: PutObjectInput): Promise<StoredObject>;
}
