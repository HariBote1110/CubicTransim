import { describe, expect, it } from 'vitest';
import { pickPart } from './partPicking';
import { projectToScreenPx, type WebGpuCameraState } from '../../render/webgpuCamera';
import { consistTransforms } from './consistLayout';
import type { TrainPart } from '../../render/trainPartsSpec';

const camera: WebGpuCameraState = {
  centreX: 0, centreZ: 0, pixelsPerUnit: 200, widthPx: 1600, heightPx: 900,
};

const part = (pos: [number, number, number]): TrainPart => ({
  kind: 'box', size: [0.2, 0.2, 0.2], pos, colour: '#8899aa',
});

describe('pickPart', () => {
  it('selects the mid-car part under the projected screen point', () => {
    const midParts: TrainPart[] = [part([0, 0, 0])];
    const t = consistTransforms(0).find(c => c.variant === 'mid')!;
    const { sx, sy } = projectToScreenPx({ x: t.x, y: t.y, z: t.z }, camera);
    const hit = pickPart(camera, sx, sy, 0, [], midParts);
    expect(hit).toEqual({ variant: 'mid', role: 'mid', index: 0 });
  });

  it('returns null when the cursor misses every part', () => {
    const midParts: TrainPart[] = [part([0, 0, 0])];
    const hit = pickPart(camera, 100000, 100000, 0, [], midParts);
    expect(hit).toBeNull();
  });

  it('picks the smaller-area candidate when two parts overlap on screen', () => {
    const midParts: TrainPart[] = [
      part([0, 0, 0]), // 大きい方(先に置く)
    ];
    midParts[0] = { ...midParts[0], size: [0.6, 0.6, 0.6] };
    const small: TrainPart = { kind: 'box', size: [0.05, 0.05, 0.05], pos: [0, 0, 0], colour: '#fff' };
    const parts = [midParts[0], small];
    const t = consistTransforms(0).find(c => c.variant === 'mid')!;
    const { sx, sy } = projectToScreenPx({ x: t.x, y: t.y, z: t.z }, camera);
    const hit = pickPart(camera, sx, sy, 0, [], parts);
    expect(hit?.index).toBe(1);
  });
});
