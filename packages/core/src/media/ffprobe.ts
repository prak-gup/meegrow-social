import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Override for CI/prod images that install ffmpeg somewhere non-standard. Defaults to PATH lookup. */
function ffprobeBin(): string {
  return process.env.FFPROBE_PATH ?? 'ffprobe';
}

let _available: boolean | undefined;

/** Cheap one-time check so callers can degrade gracefully instead of throwing on every upload. */
export function isFfprobeAvailable(): boolean {
  if (_available === undefined) {
    try {
      execFileSync(ffprobeBin(), ['-version'], { stdio: 'ignore' });
      _available = true;
    } catch {
      _available = false;
    }
  }
  return _available;
}

export interface ProbedMeta {
  width?: number;
  height?: number;
  durationSeconds?: number;
  codec?: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}
interface FfprobeFormat {
  duration?: string;
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/**
 * Probes a local file with ffprobe (codec/dimensions/duration) — no transcoding, ever (AX-PRD).
 * Requires `ffprobe` on PATH (present on the deploy image + GitHub Actions runners + local dev via
 * homebrew/apt). Throws if ffprobe is missing or the file can't be parsed; callers decide how to
 * surface that (media.ts treats a probe failure as an upload failure, not a silent pass).
 */
export async function probeFile(filePath: string): Promise<ProbedMeta> {
  const { stdout } = await execFileAsync(ffprobeBin(), [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  const json = JSON.parse(stdout) as FfprobeOutput;
  const visual =
    json.streams?.find((s) => s.codec_type === 'video' || s.codec_type === 'image') ??
    json.streams?.[0];
  const rawDuration = json.format?.duration;
  const duration = rawDuration ? Number(rawDuration) : undefined;
  return {
    width: visual?.width,
    height: visual?.height,
    durationSeconds: duration != null && Number.isFinite(duration) ? duration : undefined,
    codec: visual?.codec_name,
  };
}
