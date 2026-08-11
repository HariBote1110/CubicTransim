import { describe, expect, it } from 'vitest';
import { worldToOverlayPx, isOnScreen } from './labelOverlay';
import type { WebGpuCameraState } from './webgpuCamera';

const camera: WebGpuCameraState = { centreX: 0, centreZ: 0, pixelsPerUnit: 80, widthPx: 2560, heightPx: 1440 };
const dpr = 2;

describe('worldToOverlayPx', () => {
  it('places the camera centre (y=0) at the CSS-space centre of the container', () => {
    const pos = worldToOverlayPx({ x: 0, y: 0, z: 0 }, camera, dpr);
    expect(pos.left).toBeCloseTo(camera.widthPx / dpr / 2, 6);
    expect(pos.top).toBeCloseTo(camera.heightPx / dpr / 2, 6);
    expect(pos.offscreenMargin).toBeLessThan(0);
  });

  it('moves right/down consistently with projectToScreenPx for a world offset', () => {
    const pos = worldToOverlayPx({ x: 5, y: 0, z: 5 }, camera, dpr);
    // x+z>0 かつ dpr で割った分だけCSS空間で中心からずれる
    expect(pos.top).toBeGreaterThan(camera.heightPx / dpr / 2);
  });

  it('flags points far outside the viewport as offscreen', () => {
    const pos = worldToOverlayPx({ x: 500, y: 0, z: 500 }, camera, dpr);
    expect(isOnScreen(pos)).toBe(false);
  });

  it('treats the centre point as onscreen', () => {
    const pos = worldToOverlayPx({ x: 0, y: 0, z: 0 }, camera, dpr);
    expect(isOnScreen(pos)).toBe(true);
  });
});
