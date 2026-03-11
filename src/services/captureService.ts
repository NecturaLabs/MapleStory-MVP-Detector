/**
 * captureService.ts
 * Browser Screen Capture API — single MapleStory window capture.
 * Must be called from a user-gesture handler (click).
 */

/**
 * Start screen capture. Shows the browser's native window/screen picker.
 * @param onEnded — callback when the stream ends (user stops sharing)
 */
export async function startCapture(onEnded: () => void): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      displaySurface: 'window', // hint browser to prefer window selection
    } as MediaTrackConstraints,
    audio: false,
    // @ts-expect-error — non-standard but supported in Chrome
    selfBrowserSurface: 'exclude',
    monitorTypeSurfaces: 'exclude',
  });

  // Listen for user stopping share (X button in browser chrome)
  const [track] = stream.getVideoTracks();
  if (track && onEnded) {
    track.addEventListener('ended', onEnded, { once: true });
  }

  return stream;
}

/**
 * Stop a MediaStream (stop all tracks).
 */
export function stopCapture(stream: MediaStream): void {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}

// ---------------------------------------------------------------------------
// Region extraction
// ---------------------------------------------------------------------------

let _canvas: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;

function getCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (!_canvas) {
    _canvas = document.createElement('canvas');
    _ctx = _canvas.getContext('2d', { willReadFrequently: true })!;
  }
  if (_canvas.width !== w || _canvas.height !== h) {
    _canvas.width = w;
    _canvas.height = h;
  }
  return { canvas: _canvas, ctx: _ctx! };
}

/**
 * Extract the full frame from the video element as ImageData.
 */
export function extractFrame(video: HTMLVideoElement): ImageData | null {
  if (!video) return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const { ctx } = getCanvas(vw, vh);
  ctx.drawImage(video, 0, 0, vw, vh);
  return ctx.getImageData(0, 0, vw, vh);
}
