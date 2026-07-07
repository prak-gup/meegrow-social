import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type { PutObjectInput, StorageDriver, StoredObject } from './types.js';

export interface DiskStorageOptions {
  /** Absolute directory files are written under. */
  rootDir: string;
  /** Base URL files are served from (apps/api mounts a static route here in dev/test). */
  publicBaseUrl: string;
}

/** Local-disk storage — dev + test backend. Never selected in prod (AX-PRD: S3 there). */
export class DiskStorageDriver implements StorageDriver {
  readonly kind = 'disk' as const;

  constructor(private readonly opts: DiskStorageOptions) {}

  async put(input: PutObjectInput): Promise<StoredObject> {
    const ext = extname(input.filename);
    const key = `${input.workspaceId}/${randomUUID()}${ext}`;
    const filePath = join(this.opts.rootDir, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, input.data);
    const url = `${this.opts.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
    return { key, url };
  }
}
