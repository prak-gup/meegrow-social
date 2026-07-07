import type { StorageDriver } from './types.js';
import { DiskStorageDriver } from './disk.js';
import { S3StorageDriver } from './s3.js';

export * from './types.js';
export { DiskStorageDriver } from './disk.js';
export { S3StorageDriver } from './s3.js';

export const DEFAULT_MEDIA_DISK_DIR = '.data/media';
export const DEFAULT_MEDIA_PUBLIC_BASE_URL = 'http://localhost:8990/media';

let _driver: StorageDriver | undefined;

/** DI hook for tests (and the S3 driver's injectable client) — bypasses env resolution entirely. */
export function setStorageDriver(driver: StorageDriver): void {
  _driver = driver;
}

/** Test-only: clear the cached driver so the next getStorageDriver() call re-reads env. */
export function resetStorageDriver(): void {
  _driver = undefined;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/**
 * Env-selected storage driver (AX-PRD §1: local disk in dev/test, S3 in prod — driver interface).
 * `MEDIA_STORAGE_DRIVER` defaults to "disk" so local dev and CI never need AWS credentials; set it
 * to "s3" (+ S3_BUCKET/S3_REGION) in production.
 */
export function getStorageDriver(): StorageDriver {
  if (_driver) return _driver;
  const kind = process.env.MEDIA_STORAGE_DRIVER ?? 'disk';
  if (kind === 's3') {
    _driver = new S3StorageDriver({
      bucket: need('S3_BUCKET'),
      region: process.env.S3_REGION ?? 'ap-south-1',
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL,
    });
  } else {
    _driver = new DiskStorageDriver({
      rootDir: process.env.MEDIA_DISK_DIR ?? DEFAULT_MEDIA_DISK_DIR,
      publicBaseUrl: process.env.MEDIA_PUBLIC_BASE_URL ?? DEFAULT_MEDIA_PUBLIC_BASE_URL,
    });
  }
  return _driver;
}
