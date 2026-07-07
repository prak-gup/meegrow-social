import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskStorageDriver } from './disk.js';
import { S3StorageDriver } from './s3.js';
import { getStorageDriver, resetStorageDriver, setStorageDriver } from './index.js';

const ENV_KEYS = [
  'MEDIA_STORAGE_DRIVER',
  'MEDIA_DISK_DIR',
  'MEDIA_PUBLIC_BASE_URL',
  'S3_BUCKET',
  'S3_REGION',
];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetStorageDriver();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetStorageDriver();
});

describe('getStorageDriver (env-selected, AX-PRD: disk in dev/test, S3 in prod)', () => {
  it('defaults to disk when MEDIA_STORAGE_DRIVER is unset', () => {
    expect(getStorageDriver()).toBeInstanceOf(DiskStorageDriver);
  });

  it('selects disk explicitly', () => {
    process.env.MEDIA_STORAGE_DRIVER = 'disk';
    expect(getStorageDriver()).toBeInstanceOf(DiskStorageDriver);
  });

  it('selects S3 when configured, without ever touching AWS', () => {
    process.env.MEDIA_STORAGE_DRIVER = 's3';
    process.env.S3_BUCKET = 'test-bucket';
    process.env.S3_REGION = 'ap-south-1';
    const driver = getStorageDriver();
    expect(driver).toBeInstanceOf(S3StorageDriver);
    expect(driver.kind).toBe('s3');
  });

  it('throws a clear error if S3 is selected without a bucket configured', () => {
    process.env.MEDIA_STORAGE_DRIVER = 's3';
    expect(() => getStorageDriver()).toThrow(/S3_BUCKET/);
  });

  it('caches the resolved driver across calls', () => {
    expect(getStorageDriver()).toBe(getStorageDriver());
  });

  it('setStorageDriver overrides env resolution (test/DI hook)', () => {
    const injected = new DiskStorageDriver({ rootDir: '/tmp/x', publicBaseUrl: 'http://x' });
    setStorageDriver(injected);
    expect(getStorageDriver()).toBe(injected);
  });
});
