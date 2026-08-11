import { describe, expect, it } from 'vitest';
import {
  chunkViewFromCamera, clientToScreenPx, pickGroundCell, pickTerrainCell,
  screenPxToGround, visibleGroundBounds,
} from './picking';
import { projectToScreenPx, type WebGpuCameraState } from './webgpuCamera';
import { OVERPASS_HEIGHT } from '../sim/trackPath';
import type { TerrainField } from '../sim/terrainField';

const camera = (over: Partial<WebGpuCameraState> = {}): WebGpuCameraState => ({
  centreX: 0, centreZ: 0, pixelsPerUnit: 80, widthPx: 2560, heightPx: 1440, ...over,
});

describe('screenPxToGround', () => {
  it('inverts projectToScreenPx at ground level', () => {
    const cam = camera({ centreX: -13.5, centreZ: 7.25, pixelsPerUnit: 61.5 });
    for (const world of [{ x: 0, z: 0 }, { x: 12, z: -30 }, { x: -400.25, z: 88.5 }]) {
      const { sx, sy } = projectToScreenPx({ x: world.x, y: 0, z: world.z }, cam);
      const back = screenPxToGround(cam, sx, sy, 0);
      expect(back.x).toBeCloseTo(world.x, 6);
      expect(back.z).toBeCloseTo(world.z, 6);
    }
  });

  it('inverts projectToScreenPx at an elevated plane', () => {
    const cam = camera({ centreX: 4, centreZ: -9, pixelsPerUnit: 37 });
    const y = 3 * OVERPASS_HEIGHT;
    const { sx, sy } = projectToScreenPx({ x: 18, y, z: -5 }, cam);
    const back = screenPxToGround(cam, sx, sy, y);
    expect(back.x).toBeCloseTo(18, 6);
    expect(back.z).toBeCloseTo(-5, 6);
  });

  it('shifts by exactly the height along both axes when the plane is raised', () => {
    // The isometric camera looks along (-1,-1,-1)/sqrt3, so a point at height h projects
    // to the same pixel as the ground point (x-h, z-h).
    const cam = camera();
    const ground = screenPxToGround(cam, 120, -40, 0);
    const raised = screenPxToGround(cam, 120, -40, 2);
    expect(raised.x).toBeCloseTo(ground.x + 2, 9);
    expect(raised.z).toBeCloseTo(ground.z + 2, 9);
  });
});

describe('clientToScreenPx', () => {
  it('converts a DOM client point into centre-origin physical pixels', () => {
    const rect = { left: 10, top: 20, width: 1280, height: 720 };
    expect(clientToScreenPx(10 + 640, 20 + 360, rect, 2)).toEqual({ sx: 0, sy: 0 });
    expect(clientToScreenPx(10 + 640 + 100, 20 + 360 - 50, rect, 2)).toEqual({ sx: 200, sy: -100 });
  });
});

describe('pickGroundCell', () => {
  it('rounds the continuous ground point to the nearest cell', () => {
    const cam = camera();
    const { sx, sy } = projectToScreenPx({ x: 6.4, y: 0, z: -2.3 }, cam);
    expect(pickGroundCell(cam, sx, sy)).toEqual({ x: 6, z: -2 });
  });
});

/** cellHeightAt だけを持つ最小のスタブ地形(pickTerrainCell が使うのはこれだけ)。 */
const stubField = (heights: Map<string, number>): TerrainField =>
  ({ cellHeightAt: (x: number, z: number) => heights.get(`${x},${z}`) ?? 0 }) as unknown as TerrainField;

describe('pickTerrainCell', () => {
  it('returns the flat-ground cell when nothing is raised', () => {
    const cam = camera();
    const field = stubField(new Map());
    const { sx, sy } = projectToScreenPx({ x: 3, y: 0, z: 5 }, cam);
    expect(pickTerrainCell(cam, sx, sy, field)).toEqual({ x: 3, z: 5 });
  });

  it('picks the hill top the cursor is visually over, not the ground cell behind it', () => {
    // A hill of height 4 (= 3.2 world units) at (10,10). Clicking its top face lands on
    // the y=0 plane at (6.8, 6.8), so a naive ground pick would select the wrong cell.
    const cam = camera();
    const height = 4;
    const offset = Math.round(height * OVERPASS_HEIGHT);
    const field = stubField(new Map([['10,10', height]]));
    const { sx, sy } = projectToScreenPx({ x: 10, y: height * OVERPASS_HEIGHT, z: 10 }, cam);
    expect(pickGroundCell(cam, sx, sy)).toEqual({ x: 10 - offset, z: 10 - offset });
    expect(pickTerrainCell(cam, sx, sy, field)).toEqual({ x: 10, z: 10 });
  });

  it('prefers the highest matching cell when several heights line up on one pixel', () => {
    // Both (10,10) at height 4 and (6,6) at height 0 project onto the same pixel.
    const cam = camera();
    const field = stubField(new Map([['10,10', 4]]));
    const { sx, sy } = projectToScreenPx({ x: 10, y: 4 * OVERPASS_HEIGHT, z: 10 }, cam);
    expect(pickTerrainCell(cam, sx, sy, field)).toEqual({ x: 10, z: 10 });
  });

  it('falls back to the ground cell when no candidate height is self-consistent', () => {
    const cam = camera();
    // (3,5) is flat but its neighbours are not: no raised cell lines up with the pixel.
    const field = stubField(new Map([['-1,-1', 7]]));
    const { sx, sy } = projectToScreenPx({ x: 3, y: 0, z: 5 }, cam);
    expect(pickTerrainCell(cam, sx, sy, field)).toEqual({ x: 3, z: 5 });
  });
});

describe('visibleGroundBounds', () => {
  it('covers the four viewport corners projected onto the ground plane', () => {
    const cam = camera({ centreX: 0, centreZ: 0, pixelsPerUnit: 80, widthPx: 1600, heightPx: 900 });
    const bounds = visibleGroundBounds(cam);
    for (const sx of [-cam.widthPx / 2, cam.widthPx / 2]) {
      for (const sy of [-cam.heightPx / 2, cam.heightPx / 2]) {
        const p = screenPxToGround(cam, sx, sy, 0);
        expect(p.x).toBeGreaterThanOrEqual(bounds.minX - 1e-6);
        expect(p.x).toBeLessThanOrEqual(bounds.maxX + 1e-6);
        expect(p.z).toBeGreaterThanOrEqual(bounds.minZ - 1e-6);
        expect(p.z).toBeLessThanOrEqual(bounds.maxZ + 1e-6);
      }
    }
  });

  it('is centred on the camera centre for a centred camera', () => {
    const cam = camera({ centreX: 100, centreZ: -50 });
    const bounds = visibleGroundBounds(cam);
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(100, 6);
    expect((bounds.minZ + bounds.maxZ) / 2).toBeCloseTo(-50, 6);
  });
});

describe('chunkViewFromCamera', () => {
  it('reports the centre cell and half the larger span as the radius', () => {
    const cam = camera({ centreX: 20, centreZ: -8 });
    const view = chunkViewFromCamera(cam);
    const bounds = visibleGroundBounds(cam);
    expect(view.targetCell).toEqual({ x: 20, z: -8 });
    expect(view.viewRadiusCells).toBe(
      Math.ceil(Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2),
    );
  });

  it('clamps the radius to the map half extent when one is given', () => {
    const cam = camera({ pixelsPerUnit: 0.05 });
    expect(chunkViewFromCamera(cam, 128).viewRadiusCells).toBe(128);
  });

  it('never reports a negative radius for a degenerate camera', () => {
    const cam = camera({ widthPx: 0, heightPx: 0 });
    expect(chunkViewFromCamera(cam).viewRadiusCells).toBeGreaterThanOrEqual(0);
  });
});
