import { describe, expect, it } from 'vitest';
import { pickTrainAtScreenPoint, TRAIN_PICK_RADIUS_PX } from './trainPicking';
import { projectToScreenPx, type WebGpuCameraState } from './webgpuCamera';

const camera: WebGpuCameraState = { centreX: 0, centreZ: 0, pixelsPerUnit: 40, widthPx: 800, heightPx: 600 };

describe('pickTrainAtScreenPoint', () => {
  it('returns null when no candidate is within range', () => {
    const result = pickTrainAtScreenPoint(
      [{ trainId: 'a', worldX: 20, worldY: 0.5, worldZ: 20 }],
      { sx: 0, sy: 0 },
      camera,
    );
    expect(result).toBeNull();
  });

  it('picks the train under the cursor', () => {
    const target = projectToScreenPx({ x: 3, y: 0.5, z: -2 }, camera);
    const result = pickTrainAtScreenPoint(
      [
        { trainId: 'far', worldX: 20, worldY: 0.5, worldZ: 20 },
        { trainId: 'near', worldX: 3, worldY: 0.5, worldZ: -2 },
      ],
      target,
      camera,
    );
    expect(result).toBe('near');
  });

  it('picks the closest candidate when several are within radius', () => {
    const base = projectToScreenPx({ x: 0, y: 0.5, z: 0 }, camera);
    const result = pickTrainAtScreenPoint(
      [
        { trainId: 'slightly-off', worldX: 0.3, worldY: 0.5, worldZ: 0 },
        { trainId: 'exact', worldX: 0, worldY: 0.5, worldZ: 0 },
      ],
      base,
      camera,
    );
    expect(result).toBe('exact');
  });

  it('respects a custom radius', () => {
    const target = projectToScreenPx({ x: 5, y: 0.5, z: 0 }, camera);
    const cursor = { sx: target.sx + TRAIN_PICK_RADIUS_PX + 5, sy: target.sy };
    expect(pickTrainAtScreenPoint([{ trainId: 'a', worldX: 5, worldY: 0.5, worldZ: 0 }], cursor, camera)).toBeNull();
    expect(
      pickTrainAtScreenPoint([{ trainId: 'a', worldX: 5, worldY: 0.5, worldZ: 0 }], cursor, camera, 999),
    ).toBe('a');
  });
});
