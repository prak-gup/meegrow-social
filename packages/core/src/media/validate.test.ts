import { describe, expect, it } from 'vitest';
import { validateMedia } from './validate.js';

describe('validateMedia (pure — injected metadata, no ffprobe/DB)', () => {
  describe('YouTube documentation-built video metadata', () => {
    it('accepts landscape and vertical videos without restricting codecs', () => {
      expect(
        validateMedia(
          'video',
          {
            container: 'webm',
            codec: 'vp9',
            width: 1920,
            height: 1080,
            bytes: 100,
            durationSeconds: 43200,
          },
          'youtube',
        ),
      ).toEqual({ valid: true });
    });
    it('rejects empty, oversized and overlong videos', () => {
      expect(validateMedia('video', { bytes: 0 }, 'youtube').valid).toBe(false);
      expect(validateMedia('video', { bytes: 256 * 1024 ** 3 + 1 }, 'youtube').valid).toBe(false);
      expect(validateMedia('video', { durationSeconds: 43201 }, 'youtube').reason).toContain(
        '12 hours',
      );
    });
  });
  describe('instagram images', () => {
    it('accepts an in-spec JPEG (4:5 portrait, under 8MB)', () => {
      const result = validateMedia(
        'image',
        { container: 'jpeg', width: 1080, height: 1350, bytes: 2 * 1024 * 1024 },
        'instagram',
      );
      expect(result).toEqual({ valid: true });
    });

    it('accepts an in-spec JPEG at the widest allowed 1.91:1 landscape', () => {
      const result = validateMedia(
        'image',
        { container: 'jpeg', width: 1910, height: 1000, bytes: 1024 },
        'instagram',
      );
      expect(result.valid).toBe(true);
    });

    it('rejects a non-JPEG container with a human-readable reason', () => {
      const result = validateMedia(
        'image',
        { container: 'png', width: 1080, height: 1350 },
        'instagram',
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/JPEG/);
      expect(result.reason).toMatch(/PNG/);
    });

    it('rejects an out-of-range aspect ratio (too square/landscape beyond 1.91:1)', () => {
      const result = validateMedia(
        'image',
        { container: 'jpeg', width: 2000, height: 800 },
        'instagram',
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/aspect ratio/);
    });

    it('rejects an oversized file', () => {
      const result = validateMedia(
        'image',
        { container: 'jpeg', width: 1080, height: 1350, bytes: 9 * 1024 * 1024 },
        'instagram',
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/8MB/);
    });
  });

  describe('instagram reels', () => {
    const validReel = {
      container: 'mp4',
      codec: 'h264',
      width: 1080,
      height: 1920,
      durationSeconds: 15,
      bytes: 50 * 1024 * 1024,
    };

    it('accepts an in-spec 9:16 H.264 MP4 reel', () => {
      expect(validateMedia('video', validReel, 'instagram')).toEqual({ valid: true });
    });

    it('accepts MOV container too', () => {
      expect(validateMedia('video', { ...validReel, container: 'mov' }, 'instagram').valid).toBe(
        true,
      );
    });

    it('rejects a non-H.264 codec', () => {
      const result = validateMedia('video', { ...validReel, codec: 'hevc' }, 'instagram');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/H264/);
    });

    it('rejects a landscape (non-9:16) video', () => {
      const result = validateMedia(
        'video',
        { ...validReel, width: 1920, height: 1080 },
        'instagram',
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/9:16/);
    });

    it('rejects a video shorter than 3 seconds', () => {
      const result = validateMedia('video', { ...validReel, durationSeconds: 1.5 }, 'instagram');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/3-90s/);
    });

    it('rejects a video longer than 90 seconds', () => {
      const result = validateMedia('video', { ...validReel, durationSeconds: 91 }, 'instagram');
      expect(result.valid).toBe(false);
    });

    it('rejects a video over 1GB', () => {
      const result = validateMedia(
        'video',
        { ...validReel, bytes: 1.1 * 1024 * 1024 * 1024 },
        'instagram',
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/1\.0GB/);
    });
  });

  describe('platforms/kinds with no registered spec', () => {
    it('is permissive for a provider with no spec table entry', () => {
      expect(validateMedia('image', { container: 'webp' }, 'fake')).toEqual({ valid: true });
    });

    it('is permissive for gmb (no spec researched yet)', () => {
      expect(validateMedia('video', { container: 'avi' }, 'gmb')).toEqual({ valid: true });
    });
  });
});
