import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMERA, MAX_ZOOM, clampZoom, createCameraState, minZoomFor,
  panByScreenDelta, toWebGpuCameraState, wheelZoomFactor, zoomBy,
} from './cameraState';
import { ISO_X, ISO_Y, minZoomForFullMap, projectToScreenPx } from './webgpuCamera';
import { screenPxToGround } from './picking';

const viewport = { cssWidth: 1280, cssHeight: 720, dpr: 2 };

describe('createCameraState', () => {
  it('starts at the origin with the historical three.js zoom of 40', () => {
    const state = createCameraState();
    expect(state).toEqual({ centreX: 0, centreZ: 0, zoom: 40 });
    expect(DEFAULT_CAMERA.zoom).toBe(40);
  });
});

describe('toWebGpuCameraState', () => {
  it('multiplies the CSS zoom by the device pixel ratio and keeps the physical size', () => {
    const camera = toWebGpuCameraState({ centreX: 3, centreZ: -4, zoom: 40 }, viewport);
    expect(camera).toEqual({
      centreX: 3, centreZ: -4, pixelsPerUnit: 80, widthPx: 2560, heightPx: 1440,
    });
  });
});

describe('panByScreenDelta', () => {
  it('brings the ground point that was under the drag start back to the screen centre', () => {
    const before = { centreX: 12, centreZ: -7, zoom: 33 };
    const dragDx = 140;
    const dragDy = -60;
    // The world point currently drawn at (dragDx, dragDy) — physical pixels.
    const grabbed = screenPxToGround(
      toWebGpuCameraState(before, viewport), dragDx * viewport.dpr, dragDy * viewport.dpr, 0,
    );

    const after = panByScreenDelta(before, dragDx, dragDy);

    const projected = projectToScreenPx(
      { x: grabbed.x, y: 0, z: grabbed.z }, toWebGpuCameraState(after, viewport),
    );
    expect(projected.sx).toBeCloseTo(0, 6);
    expect(projected.sy).toBeCloseTo(0, 6);
  });

  it('moves the world with the pointer (dragging right pushes the centre west)', () => {
    // A purely horizontal drag of 2*ISO_X px at zoom 1 equals a world delta of (+1, -1).
    const after = panByScreenDelta({ centreX: 0, centreZ: 0, zoom: 1 }, 2 * ISO_X, 0);
    expect(after.centreX).toBeCloseTo(-1, 9);
    expect(after.centreZ).toBeCloseTo(1, 9);
  });

  it('scales inversely with zoom (a zoomed-in camera pans less world per pixel)', () => {
    const near = panByScreenDelta({ centreX: 0, centreZ: 0, zoom: 80 }, 100, 40);
    const far = panByScreenDelta({ centreX: 0, centreZ: 0, zoom: 40 }, 100, 40);
    expect(near.centreX).toBeCloseTo(far.centreX / 2, 9);
    expect(near.centreZ).toBeCloseTo(far.centreZ / 2, 9);
  });

  it('uses the vertical screen axis coefficient for pure vertical drags', () => {
    const after = panByScreenDelta({ centreX: 0, centreZ: 0, zoom: 1 }, 0, 2 * ISO_Y);
    expect(after.centreX).toBeCloseTo(-1, 9);
    expect(after.centreZ).toBeCloseTo(-1, 9);
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in when the wheel scrolls up (negative deltaY)', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
  });

  it('zooms out when the wheel scrolls down (positive deltaY)', () => {
    expect(wheelZoomFactor(100)).toBeLessThan(1);
  });

  it('is symmetric: an up notch followed by an equal down notch is a no-op', () => {
    expect(wheelZoomFactor(-100) * wheelZoomFactor(100)).toBeCloseTo(1, 9);
  });

  it('clamps absurd trackpad deltas so a single event cannot jump more than 4 notches', () => {
    expect(wheelZoomFactor(100000)).toBeCloseTo(Math.pow(0.95, 4), 9);
    expect(wheelZoomFactor(-100000)).toBeCloseTo(Math.pow(0.95, -4), 9);
  });

  it('returns 1 for a zero delta', () => {
    expect(wheelZoomFactor(0)).toBe(1);
  });
});

describe('zoomBy', () => {
  it('multiplies the zoom and leaves the centre alone (OrbitControls orthographic behaviour)', () => {
    const after = zoomBy({ centreX: 5, centreZ: 6, zoom: 40 }, 2, 1, MAX_ZOOM);
    expect(after).toEqual({ centreX: 5, centreZ: 6, zoom: 80 });
  });

  it('clamps to the supplied limits', () => {
    expect(zoomBy({ centreX: 0, centreZ: 0, zoom: 90 }, 4, 1, 100).zoom).toBe(100);
    expect(zoomBy({ centreX: 0, centreZ: 0, zoom: 2 }, 0.01, 1, 100).zoom).toBe(1);
  });
});

describe('clampZoom', () => {
  it('keeps the zoom inside the limits', () => {
    expect(clampZoom(0.0001, 0.5, 100)).toBe(0.5);
    expect(clampZoom(1000, 0.5, 100)).toBe(100);
    expect(clampZoom(42, 0.5, 100)).toBe(42);
  });
});

describe('minZoomFor', () => {
  it('matches minZoomForFullMap so the whole map can always be framed', () => {
    expect(minZoomFor(8192, 1280, 720)).toBeCloseTo(minZoomForFullMap(8192, 1280, 720), 12);
  });

  it('never returns a non-positive zoom even for a degenerate viewport', () => {
    expect(minZoomFor(8192, 0, 0)).toBeGreaterThan(0);
  });
});
