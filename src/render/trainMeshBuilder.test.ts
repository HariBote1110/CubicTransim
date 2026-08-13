import { describe, expect, it } from 'vitest';
import { buildTrainCarMesh, buildSelectionMarkerMesh, buildRouteDotMesh, PLACEHOLDER_CAR_DIMENSIONS } from './trainMeshBuilder';

const alphaOf = (packed: number): number => (packed >>> 24) & 0xff;

describe('buildTrainCarMesh', () => {
  it('produces a non-empty triangle mesh for both variants', () => {
    for (const variant of ['head', 'mid'] as const) {
      const mesh = buildTrainCarMesh(variant);
      expect(mesh).not.toBeNull();
      expect(mesh!.positions.length % 3).toBe(0);
      expect(mesh!.positions.length).toBeGreaterThan(0);
      expect(mesh!.indices.length).toBe(mesh!.positions.length / 3);
      expect(mesh!.colours.length).toBe(mesh!.positions.length / 3);
    }
  });

  it('has more geometry in the head variant than the mid variant (cab features)', () => {
    const head = buildTrainCarMesh('head')!;
    const mid = buildTrainCarMesh('mid')!;
    expect(head.positions.length).toBeGreaterThan(mid.positions.length);
  });

  it('stays within the train-model-format.md dimension budget (length<=0.92, width<=0.50)', () => {
    const mesh = buildTrainCarMesh('head')!;
    const [minX, , minZ, maxX, , maxZ] = mesh.aabb;
    expect(maxX - minX).toBeLessThanOrEqual(0.50);
    expect(maxZ - minZ).toBeLessThanOrEqual(0.92);
    expect(PLACEHOLDER_CAR_DIMENSIONS.length).toBeLessThanOrEqual(0.92);
    expect(PLACEHOLDER_CAR_DIMENSIONS.width).toBeLessThanOrEqual(0.50);
  });

  it('marks the line-colour stripe vertices with tint alpha=255 and everything else alpha=0', () => {
    const mesh = buildTrainCarMesh('mid')!;
    const alphas = new Set(Array.from(mesh.colours, alphaOf));
    expect(alphas.has(255)).toBe(true);
    expect(alphas.has(0)).toBe(true);
    // 中間的なalphaは使っていない(このメッシュ生成器は0/255の二値しか出さない)
    expect([...alphas].every(a => a === 0 || a === 255)).toBe(true);
  });
});

describe('buildTrainCarMesh（車種ごとの見た目)', () => {
  const MODEL_IDS = ['commuter', 'suburban', 'express', 'local-express'] as const;

  it('builds a non-null baked chunk for every model and both variants, within the dimension budget', () => {
    for (const modelId of MODEL_IDS) {
      for (const variant of ['head', 'mid'] as const) {
        const mesh = buildTrainCarMesh(variant, modelId);
        expect(mesh).not.toBeNull();
        const [minX, minY, minZ, maxX, maxY, maxZ] = mesh!.aabb;
        expect(maxX - minX).toBeLessThanOrEqual(0.50);
        expect(maxZ - minZ).toBeLessThanOrEqual(0.92);
        expect(minY).toBeGreaterThanOrEqual(-0.60);
        expect(maxY).toBeLessThanOrEqual(0.60);
      }
    }
  });

  it('head and mid vertex counts differ for every model (cab-only features)', () => {
    for (const modelId of MODEL_IDS) {
      const head = buildTrainCarMesh('head', modelId)!;
      const mid = buildTrainCarMesh('mid', modelId)!;
      expect(head.positions.length).not.toBe(mid.positions.length);
    }
  });

  it('the express (nose-long) head has more geometry than the commuter (flat-black) head', () => {
    const commuterHead = buildTrainCarMesh('head', 'commuter')!;
    const expressHead = buildTrainCarMesh('head', 'express')!;
    expect(expressHead.positions.length).toBeGreaterThan(commuterHead.positions.length);
  });

  it('every model keeps the tint(alpha) convention: only line-colour vertices are alpha=255', () => {
    for (const modelId of MODEL_IDS) {
      const mesh = buildTrainCarMesh('mid', modelId)!;
      const alphas = new Set(Array.from(mesh.colours, alphaOf));
      expect(alphas.has(255)).toBe(true);
      expect(alphas.has(0)).toBe(true);
      expect([...alphas].every(a => a === 0 || a === 255)).toBe(true);
    }
  });
});

describe('buildSelectionMarkerMesh / buildRouteDotMesh', () => {
  it('are fully tinted (alpha=255) so the instance tint colours them directly', () => {
    for (const mesh of [buildSelectionMarkerMesh()!, buildRouteDotMesh()!]) {
      expect(mesh.positions.length).toBeGreaterThan(0);
      expect(Array.from(mesh.colours, alphaOf).every(a => a === 255)).toBe(true);
    }
  });
});
