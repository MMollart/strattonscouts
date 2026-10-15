import { describe, it, expect } from 'vitest';
import { MAX_EDGE, outputType, shrinkSteps } from '../src/lib/shrinkImage';

describe('shrinkSteps', () => {
  it('caps the longest side and keeps the aspect ratio', () => {
    const steps = shrinkSteps(8000, 6000);
    expect(steps[0]).toEqual({ width: MAX_EDGE, height: 1920, quality: 0.85 });
    expect(steps.at(-1)).toEqual({ width: 1280, height: 960, quality: 0.72 });
    for (const s of steps) expect(Math.abs(s.width / s.height - 8000 / 6000)).toBeLessThan(0.01);
  });

  it('never enlarges a small image, only recompresses it', () => {
    expect(shrinkSteps(1000, 800)).toEqual([
      { width: 1000, height: 800, quality: 0.85 },
      { width: 1000, height: 800, quality: 0.72 },
    ]);
  });

  it('keeps transparency-capable formats as WebP and photos as JPEG', () => {
    expect(outputType('image/png')).toBe('image/webp');
    expect(outputType('image/webp')).toBe('image/webp');
    expect(outputType('image/jpeg')).toBe('image/jpeg');
    expect(outputType('image/heic')).toBe('image/jpeg');
  });
});
