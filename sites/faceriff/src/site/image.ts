/** Client-side image helpers for the generator and the phone upload page. */

export const IMAGE_ACCEPT =
  'image/png,image/jpeg,image/jpg,image/webp,image/heic,image/heif,.png,.jpg,.jpeg,.webp,.heic,.heif';

const BITMAP_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const HEIC_RE = /\.(heic|heif)$/i;
const RASTER_RE = /\.(png|jpe?g|webp|heic|heif)$/i;
const MAX_SIDE = 2048;
const JPEG_QUALITY = 0.9;

export function isHeic(file: { type?: string; name?: string }): boolean {
  return /image\/hei[cf]/i.test(file.type ?? '') || HEIC_RE.test(file.name ?? '');
}

/** True when the file looks like a photo we can try to upload (including HEIC). */
export function isSupportedImage(file: { type?: string; name?: string }): boolean {
  if (BITMAP_TYPES.has(file.type ?? '') || isHeic(file)) return true;
  const name = file.name ?? '';
  return RASTER_RE.test(name) && (!file.type || file.type === 'application/octet-stream');
}

export function assignOpenSeats<T>(openSlotIds: string[], files: T[]): { slotId: string; file: T }[] {
  const count = Math.min(openSlotIds.length, files.length);
  return openSlotIds.slice(0, count).map((slotId, i) => ({ slotId, file: files[i]! }));
}

function jpegName(name: string): string {
  return `${(name || 'photo').replace(/\.[^.]+$/, '')}.jpg`;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode JPEG'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

function drawScaled(source: ImageBitmap | HTMLImageElement, width: number, height: number): HTMLCanvasElement {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function decodeWithImageElement(file: File): Promise<{ image: HTMLImageElement; close: () => void }> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('decode failed'));
    image.src = url;
  });
  return { image, close: () => URL.revokeObjectURL(url) };
}

/**
 * Convert a picked photo to a JPEG the upload API accepts.
 * iPhone Safari can usually decode HEIC via createImageBitmap or an Image element;
 * browsers that cannot decode HEIC fail with a clear error for the caller to show.
 */
export async function prepareUploadImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const blob = await canvasToJpeg(drawScaled(bitmap, bitmap.width, bitmap.height));
      return new File([blob], jpegName(file.name), { type: 'image/jpeg' });
    } finally {
      bitmap.close();
    }
  } catch {
    // fall through to the element decoder (some iOS versions need it for HEIC)
  }
  let decoded: { image: HTMLImageElement; close: () => void } | undefined;
  try {
    decoded = await decodeWithImageElement(file);
    const blob = await canvasToJpeg(drawScaled(decoded.image, decoded.image.naturalWidth, decoded.image.naturalHeight));
    return new File([blob], jpegName(file.name), { type: 'image/jpeg' });
  } catch {
    throw new Error(isHeic(file) ? 'heic' : 'type');
  } finally {
    decoded?.close();
  }
}
