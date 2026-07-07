import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { PutObjectInput, StorageDriver, StoredObject } from './types.js';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Override for a CDN/custom domain in front of the bucket; defaults to the virtual-hosted URL. */
  publicBaseUrl?: string;
  /** Injectable for tests — never construct a real S3Client in a unit/integration test. */
  client?: S3Client;
}

/** Prod storage backend. Credentials come from the standard AWS provider chain (IAM role on EC2). */
export class S3StorageDriver implements StorageDriver {
  readonly kind = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly opts: S3StorageOptions) {
    this.client = opts.client ?? new S3Client({ region: opts.region });
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const ext = extname(input.filename);
    const key = `${input.workspaceId}/${randomUUID()}${ext}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: input.data,
        ContentType: input.contentType,
      }),
    );
    const base =
      this.opts.publicBaseUrl ?? `https://${this.opts.bucket}.s3.${this.opts.region}.amazonaws.com`;
    return { key, url: `${base.replace(/\/+$/, '')}/${key}` };
  }
}
