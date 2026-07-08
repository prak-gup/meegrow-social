import { describe, expect, it, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { S3StorageDriver } from './s3.js';

/** Never hits real AWS — send() is mocked (AX-PRD: "no AWS in CI"). */
function fakeClient() {
  const send = vi.fn().mockResolvedValue({});
  return { client: { send } as unknown as S3Client, send };
}

describe('S3StorageDriver', () => {
  it('uploads via PutObjectCommand and returns the virtual-hosted url', async () => {
    const { client, send } = fakeClient();
    const driver = new S3StorageDriver({ bucket: 'my-bucket', region: 'ap-south-1', client });

    const stored = await driver.put({
      workspaceId: 'ws_1',
      filename: 'reel.mp4',
      contentType: 'video/mp4',
      data: Buffer.from('video-bytes'),
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.Bucket).toBe('my-bucket');
    expect(command.input.Key).toBe(stored.key);
    expect(command.input.ContentType).toBe('video/mp4');
    expect(stored.key).toMatch(/^ws_1\/.+\.mp4$/);
    expect(stored.url).toBe(`https://my-bucket.s3.ap-south-1.amazonaws.com/${stored.key}`);
  });

  it('honors a custom publicBaseUrl (e.g. CDN domain)', async () => {
    const { client } = fakeClient();
    const driver = new S3StorageDriver({
      bucket: 'my-bucket',
      region: 'ap-south-1',
      publicBaseUrl: 'https://cdn.example.com/',
      client,
    });

    const stored = await driver.put({
      workspaceId: 'ws_1',
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      data: Buffer.from('img'),
    });

    expect(stored.url).toBe(`https://cdn.example.com/${stored.key}`);
  });
});
