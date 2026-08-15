import { describe, expect, it } from 'vitest';
import { decodeTrainModel } from './trainModelLoader';
import { buildGlb, boxPositionsIndices } from '../../renderer/tools/glbTestFixtures.mjs';
import { RAIL_SUPPORT_OFFSET } from './trainInstanceMath';

const toArrayBuffer = (buf: Uint8Array): ArrayBuffer =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

const alphaOf = (packed: number): number => (packed >>> 24) & 0xff;

describe('decodeTrainModel', () => {
  it('round-trips a synthetic glb with car_head + car_mid into baked meshes', () => {
    const head = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const mid = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const glb = buildGlb([
      { name: 'car_head', ...head },
      { name: 'car_mid', ...mid },
    ]);
    const model = decodeTrainModel(toArrayBuffer(glb));
    expect(model).not.toBeNull();
    expect(model!.head.positions.length).toBeGreaterThan(0);
    expect(model!.mid.positions.length).toBeGreaterThan(0);
    // aabb should roughly match the box half-extents (0.4 x 0.2 x 0.8)
    const [minX, minY, minZ, maxX, maxY, maxZ] = model!.head.aabb;
    expect(maxX - minX).toBeCloseTo(0.4, 5);
    expect(maxY - minY).toBeCloseTo(0.2, 5);
    expect(maxZ - minZ).toBeCloseTo(0.8, 5);
  });

  it('returns null when car_head is missing', () => {
    const mid = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const glb = buildGlb([{ name: 'car_mid', ...mid }]);
    expect(decodeTrainModel(toArrayBuffer(glb))).toBeNull();
  });

  it('tints faces from a material named line_colour with alpha=255, others stay at 0', () => {
    const head = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const mid = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const glb = buildGlb(
      [
        { name: 'car_head', ...head, material: 0 },
        { name: 'car_mid', ...mid },
      ],
      {
        materials: [{ name: 'line_colour', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
      },
    );
    const model = decodeTrainModel(toArrayBuffer(glb));
    expect(model).not.toBeNull();
    expect(Array.from(model!.head.colours, alphaOf).every(a => a === 255)).toBe(true);
    expect(Array.from(model!.mid.colours, alphaOf).every(a => a === 0)).toBe(true);
  });

  it('shifts baked geometry down by RAIL_SUPPORT_OFFSET so authored y=0 (rail top) lands on the wheel-contact plane', () => {
    // Authored per progress/train-model-format.md: box spans y=[0, 0.2], i.e. rail top at y=0.
    const head = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const mid = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const glb = buildGlb([
      { name: 'car_head', ...head },
      { name: 'car_mid', ...mid },
    ]);
    const model = decodeTrainModel(toArrayBuffer(glb));
    expect(model).not.toBeNull();
    const [, minY] = model!.head.aabb;
    expect(minY).toBeCloseTo(-RAIL_SUPPORT_OFFSET, 5);
  });
});
