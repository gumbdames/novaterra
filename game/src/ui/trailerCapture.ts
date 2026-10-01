/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — ui/trailerCapture.ts — in-game trailer recording
 * (trailer workstream, 2026-10-01).
 *
 * Responsibilities:
 *  - Record the render canvas straight to a downloadable `.webm` via
 *    `canvas.captureStream()` + `MediaRecorder` — no OBS, no external
 *    tools. `startTrailerCapture()` picks the best supported codec
 *    (vp9 → vp8 → container default) and returns a handle whose
 *    `stop()` resolves with the recorded `Blob`.
 *  - Graceful degradation: when `MediaRecorder` or `captureStream` is
 *    unavailable (headless, old browser), `startTrailerCapture()`
 *    returns `null` and logs why — it never throws. The trailer mode
 *    then shows the OBS fallback instructions instead.
 *  - Pure, headless-safe codec selection (`resolveTrailerMimeType`)
 *    so the fallback chain is unit-tested without a browser.
 */

/** Codec preference order: best quality first. */
export const TRAILER_MIME_PREFERENCE = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

/** Default recording bitrate: 10 Mbps — clean 1080p60 game footage. */
export const TRAILER_DEFAULT_BITRATE = 10_000_000;

/**
 * Pick the first mime type the runtime supports. `isSupported` is
 * `MediaRecorder.isTypeSupported` in the browser; tests inject a stub.
 * Returns '' when nothing matches (the MediaRecorder default applies).
 */
export function resolveTrailerMimeType(
  isSupported: (mimeType: string) => boolean,
): string {
  for (const mime of TRAILER_MIME_PREFERENCE) {
    try {
      if (isSupported(mime)) return mime;
    } catch {
      // A throwing isTypeSupported counts as unsupported — keep walking
      // the preference list instead of failing the recording.
    }
  }
  return '';
}

/** True when this runtime can record the canvas at all. */
export function trailerCaptureSupported(canvas: {
  captureStream?: unknown;
}): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof (canvas as { captureStream?: unknown }).captureStream === 'function'
  );
}

export interface TrailerCaptureOptions {
  /** Recording bitrate in bits/sec (default 10 Mbps). */
  videoBitsPerSecond?: number;
}

/** An active trailer recording. */
export interface TrailerCapture {
  /** The negotiated mime type ('' = MediaRecorder default). */
  readonly mimeType: string;
  /** Stop recording; resolves with the recorded video blob. */
  stop(): Promise<Blob>;
  /** Discard the recording without producing a blob. */
  cancel(): void;
}

interface CaptureStreamCanvas {
  captureStream(frameRate?: number): MediaStream;
}

/**
 * Start recording the render canvas. Returns `null` (never throws)
 * when the runtime cannot record — the caller shows the OBS fallback.
 */
export function startTrailerCapture(
  canvas: HTMLCanvasElement,
  options: TrailerCaptureOptions = {},
): TrailerCapture | null {
  if (!trailerCaptureSupported(canvas)) {
    console.warn(
      '[trailer] capture unsupported: MediaRecorder or canvas.captureStream missing — use OBS instead',
    );
    return null;
  }
  try {
    const stream = (canvas as unknown as CaptureStreamCanvas).captureStream(60);
    const isSupported =
      typeof MediaRecorder.isTypeSupported === 'function'
        ? (m: string): boolean => MediaRecorder.isTypeSupported(m)
        : (_m: string): boolean => false;
    const mimeType = resolveTrailerMimeType(isSupported);
    const recorder = new MediaRecorder(
      stream,
      {
        mimeType: mimeType === '' ? undefined : mimeType,
        videoBitsPerSecond: options.videoBitsPerSecond ?? TRAILER_DEFAULT_BITRATE,
      },
    );
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event: BlobEvent): void => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    let stopped = false;
    recorder.start(1000); // 1s timeslices — memory stays bounded on long takes
    console.info(`[trailer] recording started (${mimeType === '' ? 'default codec' : mimeType})`);
    return {
      mimeType,
      stop: (): Promise<Blob> =>
        new Promise<Blob>((resolve) => {
          if (stopped) {
            resolve(new Blob(chunks, { type: 'video/webm' }));
            return;
          }
          stopped = true;
          recorder.onstop = (): void => {
            for (const track of stream.getTracks()) track.stop();
            resolve(new Blob(chunks, { type: 'video/webm' }));
          };
          recorder.stop();
        }),
      cancel: (): void => {
        if (stopped) return;
        stopped = true;
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          // Already stopped — nothing to discard.
        }
        for (const track of stream.getTracks()) track.stop();
      },
    };
  } catch (err) {
    console.warn('[trailer] capture failed to start — use OBS instead:', err);
    return null;
  }
}

/**
 * Trigger a download of the recorded blob. Returns the object URL so
 * the caller can offer a manual retry link if the automatic click is
 * blocked.
 */
export function downloadTrailerRecording(blob: Blob, filename: string): string {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  return url;
}
