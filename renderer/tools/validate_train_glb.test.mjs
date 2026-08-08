import { describe, expect, it } from 'vitest';
import { validateTrainGlb, DIMENSION_LIMITS, TRIANGLE_BUDGET } from './validate_train_glb.mjs';
import { buildGlb, buildValidTrainGlb, boxPositionsIndices } from './glbTestFixtures.mjs';

describe('validateTrainGlb', () => {
  it('passes a minimal valid car_head + car_mid fixture', () => {
    const { ok, checks } = validateTrainGlb(buildValidTrainGlb());
    const failed = checks.filter(c => !c.ok);
    expect(failed).toEqual([]);
    expect(ok).toBe(true);
  });

  it('rejects a buffer that is not a glb (bad magic)', () => {
    const { ok, checks } = validateTrainGlb(Buffer.from('not a glb at all'));
    expect(ok).toBe(false);
    expect(checks[0].ok).toBe(false);
  });

  it('fails when car_head is missing', () => {
    const mid = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const glb = buildGlb([{ name: 'car_mid', ...mid }]);
    const { ok, checks } = validateTrainGlb(glb);
    expect(ok).toBe(false);
    expect(checks.find(c => c.name.includes('car_head'))?.ok).toBe(false);
  });

  it('fails when a car exceeds the triangle budget', () => {
    // 500三角形を超える細分化ボックス群を1ノードへ積む(各ボックス12三角形×50個=600)。
    const positions = [];
    const indices = [];
    for (let i = 0; i < 50; i++) {
      const box = boxPositionsIndices(0, 0.1, i * 0.001, 0.01, 0.01, 0.0005);
      const base = positions.length;
      positions.push(...box.positions);
      indices.push(...box.indices.map(idx => idx + base));
    }
    const mid = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const glb = buildGlb([
      { name: 'car_head', positions, indices },
      { name: 'car_mid', ...mid },
    ]);
    const { ok, checks } = validateTrainGlb(glb);
    expect(ok).toBe(false);
    const triCheck = checks.find(c => c.name.startsWith('car_head') && c.name.includes('三角形数'));
    expect(triCheck?.ok).toBe(false);
    expect(TRIANGLE_BUDGET.full).toBe(500);
  });

  it('fails when the bounding box exceeds the length limit', () => {
    const head = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 1.0); // 全長2.0 > 0.92
    const mid = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const glb = buildGlb([{ name: 'car_head', ...head }, { name: 'car_mid', ...mid }]);
    const { ok, checks } = validateTrainGlb(glb);
    expect(ok).toBe(false);
    const lenCheck = checks.find(c => c.name.includes('全長'));
    expect(lenCheck?.ok).toBe(false);
    expect(DIMENSION_LIMITS.length).toBe(0.92);
  });

  it('fails when geometry dips below y=0', () => {
    const head = boxPositionsIndices(0, -0.05, 0, 0.2, 0.1, 0.4); // minY = -0.15
    const mid = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const glb = buildGlb([{ name: 'car_head', ...head }, { name: 'car_mid', ...mid }]);
    const { ok, checks } = validateTrainGlb(glb);
    expect(ok).toBe(false);
    const yCheck = checks.find(c => c.name.includes('y<0'));
    expect(yCheck?.ok).toBe(false);
  });

  it('fails when textures/images are present', () => {
    const head = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const mid = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
    const glb = buildGlb(
      [{ name: 'car_head', ...head }, { name: 'car_mid', ...mid }],
      { images: [{ uri: 'x.png' }], textures: [{ source: 0 }] },
    );
    const { ok, checks } = validateTrainGlb(glb);
    expect(ok).toBe(false);
    expect(checks.find(c => c.name.includes('テクスチャ'))?.ok).toBe(false);
  });
});
