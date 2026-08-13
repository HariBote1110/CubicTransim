import { describe, expect, it } from 'vitest';
import { buildPartGeometry, validateParts, type TrainPart } from './trainPartsSpec';

const box = (overrides: Partial<TrainPart> = {}): TrainPart => ({
  kind: 'box',
  size: [0.1, 0.1, 0.1],
  pos: [0, 0, 0],
  colour: '#ffffff',
  ...overrides,
});

describe('buildPartGeometry', () => {
  it('builds non-empty geometry for every kind', () => {
    const parts: TrainPart[] = [
      box({ kind: 'box', size: [0.2, 0.1, 0.3] }),
      box({ kind: 'wedge', size: [0.3, 0.4, 0.5] }),
      box({ kind: 'cylinder', size: [0.1, 0.2, 0.1] }),
      box({ kind: 'cone', size: [0.1, 0.2, 0] }),
    ];
    for (const part of parts) {
      const g = buildPartGeometry(part);
      expect(g.positions.length).toBeGreaterThan(0);
      expect(g.positions.length % 9).toBe(0);
    }
  });

  it('wedge slopes from a full-height rear to a low front edge', () => {
    const g = buildPartGeometry(box({ kind: 'wedge', size: [0.3, 0.4, 0.5] }));
    let rearMaxY = -Infinity;
    let frontMaxY = -Infinity;
    for (let i = 0; i < g.positions.length; i += 3) {
      const y = g.positions[i + 1];
      const z = g.positions[i + 2];
      if (z < 0) rearMaxY = Math.max(rearMaxY, y);
      else if (z > 0) frontMaxY = Math.max(frontMaxY, y);
    }
    expect(frontMaxY).toBeLessThan(rearMaxY);
  });

  it('applies pos translation', () => {
    const g = buildPartGeometry(box({ pos: [1, 2, 3] }));
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    expect(bb.min.x).toBeCloseTo(0.95, 5);
    expect(bb.min.y).toBeCloseTo(1.95, 5);
    expect(bb.min.z).toBeCloseTo(2.95, 5);
  });

  it('applies rot (X->Y->Z euler) before translation', () => {
    // 90度Zまわし: box(0.2,0.1,0.3)のx幅とy幅が入れ替わる
    const plain = buildPartGeometry(box({ size: [0.2, 0.1, 0.3] }));
    const rotated = buildPartGeometry(box({ size: [0.2, 0.1, 0.3], rot: [0, 0, Math.PI / 2] }));
    plain.computeBoundingBox();
    rotated.computeBoundingBox();
    const p = plain.boundingBox!;
    const r = rotated.boundingBox!;
    expect(r.max.x - r.min.x).toBeCloseTo(p.max.y - p.min.y, 5);
    expect(r.max.y - r.min.y).toBeCloseTo(p.max.x - p.min.x, 5);
  });
});

describe('validateParts', () => {
  it('flags an oversized part', () => {
    const warnings = validateParts([box({ size: [0.9, 0.1, 0.1] })]);
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) expect(w).toMatch(/[぀-ヿ一-鿿]/);
  });

  it('passes a well-formed part set', () => {
    const warnings = validateParts([box({ size: [0.4, 0.2, 0.8] })]);
    expect(warnings).toEqual([]);
  });
});
