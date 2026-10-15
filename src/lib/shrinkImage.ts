/**
 * Shrink photos in the browser before upload so they fit the 5 MB limit.
 * Large images are scaled down (longest side at most MAX_EDGE pixels) and
 * re-encoded, stepping the quality and size down until the file fits.
 * JPEG and HEIC photos become JPEG; PNG and WebP become WebP, which keeps
 * transparency.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_EDGE = 2560;

/** Encoding attempts in order: [longest edge, quality]. */
export function shrinkSteps(width: number, height: number): { width: number; height: number; quality: number }[] {
  const longest = Math.max(width, height);
  const steps: { width: number; height: number; quality: number }[] = [];
  for (const edge of [MAX_EDGE, 2048, 1600, 1280]) {
    const scale = Math.min(1, edge / longest);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    for (const quality of [0.85, 0.72]) {
      if (!steps.some((s) => s.width === w && s.height === h && s.quality === quality)) steps.push({ width: w, height: h, quality });
    }
  }
  return steps;
}

export function outputType(inputType: string): 'image/jpeg' | 'image/webp' {
  return inputType === 'image/png' || inputType === 'image/webp' ? 'image/webp' : 'image/jpeg';
}

export class ShrinkError extends Error {}

/** Whether a file needs converting: over the limit, or a format the site can't store (HEIC). */
export function needsShrinking(file: File): boolean {
  return file.size > MAX_UPLOAD_BYTES || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
}

export async function shrinkImage(file: File): Promise<File> {
  if (!needsShrinking(file)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ShrinkError('This browser cannot read that image. Please save it as a JPEG, PNG or WebP and try again.');
  }
  const type = outputType(file.type);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ShrinkError('Could not shrink the image in this browser.');
  try {
    for (const step of shrinkSteps(bitmap.width, bitmap.height)) {
      canvas.width = step.width;
      canvas.height = step.height;
      ctx.clearRect(0, 0, step.width, step.height);
      ctx.drawImage(bitmap, 0, 0, step.width, step.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, step.quality));
      // Some browsers fall back to PNG when they cannot write WebP.
      if (blob && blob.size <= MAX_UPLOAD_BYTES && blob.type === type) {
        const name = file.name.replace(/\.[^.]+$/, '') + (type === 'image/webp' ? '.webp' : '.jpg');
        return new File([blob], name, { type });
      }
    }
  } finally {
    bitmap.close();
  }
  throw new ShrinkError('The image is still larger than 5 MB after shrinking. Please choose a smaller image.');
}
