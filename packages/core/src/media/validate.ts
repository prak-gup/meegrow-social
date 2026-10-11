import type {
  MediaKind,
  MediaMeta,
  MediaValidationResult,
  ProviderIdentifier,
} from '@meegrow-social/contracts';

/**
 * Per-platform "validate-and-reject" specs (issue #3 / RESEARCH.md): IG images must be JPEG with
 * an aspect ratio between 4:5 and 1.91:1, ≤8MB; IG reels must be MP4/MOV, H.264, 9:16, 3–90s,
 * ≤1GB. AX-PRD: NO transcoding — out-of-spec media is rejected with a human-readable reason, not
 * fixed. New platforms/specs are added here as they're researched; a provider with no entry (or a
 * kind with no entry) is treated as unconstrained, so `fake` and not-yet-specced providers never
 * block tests or uploads.
 */
export interface ImageSpec {
  allowedContainers: string[];
  minAspect: number;
  maxAspect: number;
  maxBytes: number;
}

export interface VideoSpec {
  allowedContainers: string[];
  allowedCodecs: string[];
  aspect: number;
  aspectTolerance: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  maxBytes: number;
}

export interface PlatformMediaSpecs {
  image?: ImageSpec;
  video?: VideoSpec;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PLATFORM_MEDIA_SPECS: Partial<Record<ProviderIdentifier, PlatformMediaSpecs>> = {
  instagram: {
    image: {
      allowedContainers: ['jpeg'],
      minAspect: 4 / 5, // 0.8 — tallest allowed portrait
      maxAspect: 1.91, // widest allowed landscape
      maxBytes: 8 * MB,
    },
    video: {
      allowedContainers: ['mp4', 'mov'],
      allowedCodecs: ['h264'],
      aspect: 9 / 16,
      aspectTolerance: 0.02,
      minDurationSeconds: 3,
      maxDurationSeconds: 90,
      maxBytes: 1 * GB,
    },
  },
  // `app.bsky.embed.images`: any image type, any shape, at most 2,000,000 bytes each.
  bluesky: {
    image: {
      allowedContainers: ['jpeg', 'png', 'webp', 'gif'],
      minAspect: 0,
      maxAspect: Number.POSITIVE_INFINITY,
      maxBytes: 2_000_000,
    },
  },
  // Telegram downloads media from our URL itself, and takes at most 5 MB for a photo sent that
  // way. (Video by URL is capped at 20 MB; `VideoSpec` cannot say only that, so Telegram's own
  // refusal is what reports it.)
  telegram: {
    image: {
      allowedContainers: ['jpeg', 'png', 'webp'],
      minAspect: 0,
      maxAspect: Number.POSITIVE_INFINITY,
      maxBytes: 5 * MB,
    },
  },
  // Discord: 20 MiB per uploaded file, of any kind this app stores.
  discord: {
    image: {
      allowedContainers: ['jpeg', 'png', 'gif', 'webp'],
      minAspect: 0,
      maxAspect: Number.POSITIVE_INFINITY,
      maxBytes: 20 * MB,
    },
  },
};

function fail(reason: string): MediaValidationResult {
  return { valid: false, reason };
}

const ok: MediaValidationResult = { valid: true };

function validateImage(
  meta: MediaMeta,
  spec: ImageSpec,
  provider: ProviderIdentifier,
): MediaValidationResult {
  if (meta.container && !spec.allowedContainers.includes(meta.container.toLowerCase())) {
    return fail(
      `${provider} images must be ${spec.allowedContainers.join('/').toUpperCase()}, got ${meta.container.toUpperCase()}`,
    );
  }
  if (meta.width != null && meta.height != null) {
    const aspect = meta.width / meta.height;
    if (aspect < spec.minAspect - 1e-6 || aspect > spec.maxAspect + 1e-6) {
      return fail(
        `${provider} images must have an aspect ratio between ${spec.minAspect.toFixed(2)} ` +
          `and ${spec.maxAspect.toFixed(2)} (4:5–1.91:1), got ${aspect.toFixed(2)} ` +
          `(${meta.width}x${meta.height})`,
      );
    }
  }
  if (meta.bytes != null && meta.bytes > spec.maxBytes) {
    return fail(
      `${provider} images must be ≤ ${(spec.maxBytes / MB).toFixed(0)}MB, got ${(meta.bytes / MB).toFixed(1)}MB`,
    );
  }
  return ok;
}

function validateVideo(
  meta: MediaMeta,
  spec: VideoSpec,
  provider: ProviderIdentifier,
): MediaValidationResult {
  if (meta.container && !spec.allowedContainers.includes(meta.container.toLowerCase())) {
    return fail(
      `${provider} reels must be ${spec.allowedContainers.join('/').toUpperCase()}, got ${meta.container.toUpperCase()}`,
    );
  }
  if (meta.codec && !spec.allowedCodecs.includes(meta.codec.toLowerCase())) {
    return fail(
      `${provider} reels must use ${spec.allowedCodecs.join('/').toUpperCase()}, got ${meta.codec.toUpperCase()}`,
    );
  }
  if (meta.width != null && meta.height != null) {
    const aspect = meta.width / meta.height;
    if (Math.abs(aspect - spec.aspect) > spec.aspectTolerance) {
      return fail(`${provider} reels must be 9:16 portrait, got ${meta.width}x${meta.height}`);
    }
  }
  if (meta.durationSeconds != null) {
    if (
      meta.durationSeconds < spec.minDurationSeconds ||
      meta.durationSeconds > spec.maxDurationSeconds
    ) {
      return fail(
        `${provider} reels must be ${spec.minDurationSeconds}-${spec.maxDurationSeconds}s, got ${meta.durationSeconds.toFixed(1)}s`,
      );
    }
  }
  if (meta.bytes != null && meta.bytes > spec.maxBytes) {
    return fail(
      `${provider} reels must be ≤ ${(spec.maxBytes / GB).toFixed(1)}GB, got ${(meta.bytes / GB).toFixed(2)}GB`,
    );
  }
  return ok;
}

/**
 * PURE validate-and-reject check: takes already-probed metadata (never touches ffprobe or the DB)
 * so it's trivially unit-testable. Unknown providers/kinds are permissive by design — see the
 * module doc above.
 */
export function validateMedia(
  kind: MediaKind,
  meta: MediaMeta,
  provider: ProviderIdentifier,
): MediaValidationResult {
  const specs = PLATFORM_MEDIA_SPECS[provider];
  if (!specs) return ok;
  if (kind === 'image') return specs.image ? validateImage(meta, specs.image, provider) : ok;
  return specs.video ? validateVideo(meta, specs.video, provider) : ok;
}
