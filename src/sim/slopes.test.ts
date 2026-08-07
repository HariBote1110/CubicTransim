import { describe, expect, it } from 'vitest';
import {
  allowedRailConnections,
  canPlaceFlatStructure,
  edgeHeights,
  pathSlopeViolations,
  railEdgeContinuous,
  slopeOf,
  SLOPE_RAIL_COST_MULTIPLIER,
} from './slopes';
import { DIR } from '../utils';
import type { CellCorners, TerrainField } from './terrainField';

// 手組みのTerrainFieldスタブ。cornerのMapをそのまま(x,z)キーで持ち、cellCornerHeightsは
// fieldFromMaps/createTerrainFieldと同じ規約(nw=(x,z),ne=(x+1,z),sw=(x,z+1),se=(x+1,z+1))。
const stubField = (corners: Record<string, number>): TerrainField => {
  const cornerHeightAt = (x: number, z: number): number => corners[`${x},${z}`] ?? 0;
  const cellCornerHeights = (x: number, z: number): CellCorners => [
    cornerHeightAt(x, z),
    cornerHeightAt(x + 1, z),
    cornerHeightAt(x, z + 1),
    cornerHeightAt(x + 1, z + 1),
  ];
  return {
    cornerHeightAt,
    cellCornerHeights,
    cellHeightAt: (x, z) => Math.min(...cellCornerHeights(x, z)),
    terrainTypeAt: (x, z) => (Math.min(...cellCornerHeights(x, z)) >= 1 ? 'mountain' : 'grass'),
  };
};

describe('slopeOf', () => {
  it('classifies all-equal corners as flat, at any base height', () => {
    expect(slopeOf([0, 0, 0, 0])).toEqual({ kind: 'flat', height: 0 });
    expect(slopeOf([3, 3, 3, 3])).toEqual({ kind: 'flat', height: 3 });
  });

  it('classifies the 4 incline orientations (adjacent-edge +1)', () => {
    // N辺(nw,ne)がS辺(sw,se)より高い → 北へ登る
    expect(slopeOf([1, 1, 0, 0])).toEqual({ kind: 'incline', dir: DIR.N, low: 0, high: 1 });
    // S辺が高い → 南へ登る
    expect(slopeOf([0, 0, 1, 1])).toEqual({ kind: 'incline', dir: DIR.S, low: 0, high: 1 });
    // E辺(ne,se)が高い → 東へ登る
    expect(slopeOf([0, 1, 0, 1])).toEqual({ kind: 'incline', dir: DIR.E, low: 0, high: 1 });
    // W辺(nw,sw)が高い → 西へ登る
    expect(slopeOf([1, 0, 1, 0])).toEqual({ kind: 'incline', dir: DIR.W, low: 0, high: 1 });
  });

  it('classifies inclines correctly at a non-zero base height', () => {
    expect(slopeOf([5, 5, 4, 4])).toEqual({ kind: 'incline', dir: DIR.N, low: 4, high: 5 });
  });

  it('classifies a single raised corner as other', () => {
    expect(slopeOf([1, 0, 0, 0]).kind).toBe('other'); // nw raised
    expect(slopeOf([0, 1, 0, 0]).kind).toBe('other'); // ne raised
    expect(slopeOf([0, 0, 1, 0]).kind).toBe('other'); // sw raised
    expect(slopeOf([0, 0, 0, 1]).kind).toBe('other'); // se raised
  });

  it('classifies a single lowered corner (three raised) as other', () => {
    expect(slopeOf([0, 1, 1, 1]).kind).toBe('other');
    expect(slopeOf([1, 0, 1, 1]).kind).toBe('other');
    expect(slopeOf([1, 1, 0, 1]).kind).toBe('other');
    expect(slopeOf([1, 1, 1, 0]).kind).toBe('other');
  });

  it('classifies the diagonal saddle (nw=se != ne=sw) as other', () => {
    expect(slopeOf([1, 0, 0, 1]).kind).toBe('other'); // nw=se=1, ne=sw=0
    expect(slopeOf([0, 1, 1, 0]).kind).toBe('other'); // ne=sw=1, nw=se=0
  });

  it('exhaustively covers all 16 corner combinations with deltas in {0,1}', () => {
    const results: Record<string, number> = { flat: 0, incline: 0, other: 0 };
    for (let bits = 0; bits < 16; bits++) {
      const corners: CellCorners = [
        (bits >> 0) & 1,
        (bits >> 1) & 1,
        (bits >> 2) & 1,
        (bits >> 3) & 1,
      ];
      results[slopeOf(corners).kind]++;
    }
    // 4隅×2値の16通り: flat=2(全0/全1), incline=4(隣接2隅), other=10(単独隆起4 + 3隅隆起4 + 対角鞍点2)
    expect(results).toEqual({ flat: 2, incline: 4, other: 10 });
  });
});

describe('allowedRailConnections', () => {
  const ALL_8 = DIR.N | DIR.NE | DIR.E | DIR.SE | DIR.S | DIR.SW | DIR.W | DIR.NW;

  it('flat allows all 8 directions', () => {
    expect(allowedRailConnections({ kind: 'flat', height: 0 })).toBe(ALL_8);
  });

  it('incline allows only the two directions along its axis', () => {
    expect(allowedRailConnections({ kind: 'incline', dir: DIR.N, low: 0, high: 1 })).toBe(DIR.N | DIR.S);
    expect(allowedRailConnections({ kind: 'incline', dir: DIR.S, low: 0, high: 1 })).toBe(DIR.N | DIR.S);
    expect(allowedRailConnections({ kind: 'incline', dir: DIR.E, low: 0, high: 1 })).toBe(DIR.E | DIR.W);
    expect(allowedRailConnections({ kind: 'incline', dir: DIR.W, low: 0, high: 1 })).toBe(DIR.E | DIR.W);
  });

  it('other allows nothing', () => {
    expect(allowedRailConnections({ kind: 'other' })).toBe(0);
  });
});

describe('canPlaceFlatStructure', () => {
  it('is true only for flat, regardless of height', () => {
    expect(canPlaceFlatStructure({ kind: 'flat', height: 0 })).toBe(true);
    expect(canPlaceFlatStructure({ kind: 'flat', height: 7 })).toBe(true);
    expect(canPlaceFlatStructure({ kind: 'incline', dir: DIR.N, low: 0, high: 1 })).toBe(false);
    expect(canPlaceFlatStructure({ kind: 'other' })).toBe(false);
  });
});

describe('edgeHeights', () => {
  const corners: CellCorners = [1, 2, 3, 4]; // nw,ne,sw,se

  it('returns the two corners forming each cardinal edge', () => {
    expect(edgeHeights(corners, DIR.N)).toEqual([1, 2]);
    expect(edgeHeights(corners, DIR.S)).toEqual([3, 4]);
    expect(edgeHeights(corners, DIR.E)).toEqual([2, 4]);
    expect(edgeHeights(corners, DIR.W)).toEqual([1, 3]);
  });

  it('returns the single shared vertex height (duplicated) for diagonal directions', () => {
    expect(edgeHeights(corners, DIR.NW)).toEqual([1, 1]);
    expect(edgeHeights(corners, DIR.NE)).toEqual([2, 2]);
    expect(edgeHeights(corners, DIR.SW)).toEqual([3, 3]);
    expect(edgeHeights(corners, DIR.SE)).toEqual([4, 4]);
  });
});

describe('railEdgeContinuous', () => {
  it('flat-flat at the same height is continuous', () => {
    expect(railEdgeContinuous([0, 0, 0, 0], [0, 0, 0, 0], DIR.E)).toBe(true);
  });

  it('flat-flat at different heights is not continuous', () => {
    expect(railEdgeContinuous([0, 0, 0, 0], [1, 1, 1, 1], DIR.E)).toBe(false);
  });

  it('flat connects to the low side of an incline', () => {
    // A: flat height0, east隣接のB: incline(西側=A側が低い,東側が高い) → 西辺(A側)は0で一致
    const flat: CellCorners = [0, 0, 0, 0];
    const inclineE: CellCorners = [0, 1, 0, 1]; // nw=sw=0(西=低い), ne=se=1(東=高い)
    expect(railEdgeContinuous(flat, inclineE, DIR.E)).toBe(true);
  });

  it('flat at height+1 connects to the high side of an incline', () => {
    // A: flat height1, east隣接のB: incline(西側=A側が高い,東側が低い) → 西辺(A側)は1で一致
    const flatHigh: CellCorners = [1, 1, 1, 1];
    const inclineW: CellCorners = [1, 0, 1, 0]; // nw=sw=1(西=高い), ne=se=0(東=低い)
    expect(railEdgeContinuous(flatHigh, inclineW, DIR.E)).toBe(true);
  });

  it('chains inclines into a staircase (high edge of one meets low edge of next)', () => {
    const step1: CellCorners = [1, 0, 1, 0]; // W辺=1,E辺=0 (西が高い)
    const step2: CellCorners = [2, 1, 2, 1]; // W辺=2,E辺=1
    // step2の東(低い側,1)がstep1の西(高い側,1)と繋がる
    expect(railEdgeContinuous(step2, step1, DIR.E)).toBe(true);
    // 逆に合わない組み合わせ
    const step3: CellCorners = [3, 2, 3, 2];
    expect(railEdgeContinuous(step1, step3, DIR.W)).toBe(false);
  });

  it('diagonal connection requires both cells flat and the shared corner to match', () => {
    const flatA: CellCorners = [0, 0, 0, 0];
    const flatB: CellCorners = [0, 0, 0, 0];
    expect(railEdgeContinuous(flatA, flatB, DIR.SE)).toBe(true);
  });

  it('diagonal connection is rejected if either side is an incline (no diagonal track on slopes)', () => {
    const flatA: CellCorners = [0, 0, 0, 0];
    const inclineB: CellCorners = [1, 0, 1, 0];
    expect(railEdgeContinuous(flatA, inclineB, DIR.SE)).toBe(false);
  });

  it('diagonal connection is rejected if flat heights differ', () => {
    const flatA: CellCorners = [0, 0, 0, 0];
    const flatB: CellCorners = [1, 1, 1, 1];
    expect(railEdgeContinuous(flatA, flatB, DIR.SE)).toBe(false);
  });
});

describe('pathSlopeViolations', () => {
  it('is empty for a flat straight path', () => {
    const field = stubField({}); // 全コーナー未登録=0=平坦
    const path = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 2, z: 0 },
    ];
    expect(pathSlopeViolations(field, path)).toEqual([]);
  });

  it('flags other-slope for a single-corner-raised cell on the path', () => {
    // セル(0,0)のnwだけ+1にする(1隅隆起=other)
    const field = stubField({ '0,0': 1 });
    const path = [{ x: 0, z: 0 }];
    const violations = pathSlopeViolations(field, path);
    expect(violations).toContainEqual({ index: 0, reason: 'other-slope' });
  });

  it('flags direction-blocked when the path bends across an incline axis', () => {
    // セル(0,0)を N-S incline にする(nw=ne=1, sw=se=0)。
    // corners key: (0,0)=nw,(1,0)=ne,(0,1)=sw,(1,1)=se
    const field = stubField({ '0,0': 1, '1,0': 1, '0,1': 0, '1,1': 0 });
    // path: (0,-1) -> (0,0) -> (1,0) は東への折れ(inclineはN-Sのみ許可)
    const path = [
      { x: 0, z: -1 },
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    ];
    const violations = pathSlopeViolations(field, path);
    expect(violations.some(v => v.index === 1 && v.reason === 'direction-blocked')).toBe(true);
  });

  it('flags edge-discontinuous when consecutive cells do not line up in height', () => {
    // 実際のTerrainFieldはコーナーを隣接セル間で共有するため、隣接セルの共有辺は
    // 構造的に必ず一致する(railEdgeContinuous自体の単体テストで検証済み)。ここでは
    // pathSlopeViolationsが「食い違ったデータを渡されたら検出できる」ことを確認するため、
    // コーナー共有を意図的に無視するfieldダブルを使う(実運用のfieldでは起こらない想定)。
    const inconsistentField: TerrainField = {
      cornerHeightAt: () => 0,
      cellCornerHeights: (x, z) => (x === 0 && z === 0 ? [0, 0, 0, 0] : [1, 1, 1, 1]),
      cellHeightAt: () => 0,
      terrainTypeAt: () => 'grass',
    };
    const path = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    ];
    const violations = pathSlopeViolations(inconsistentField, path);
    expect(violations).toContainEqual({ index: 0, reason: 'edge-discontinuous' });
  });
});

describe('SLOPE_RAIL_COST_MULTIPLIER', () => {
  it('is the documented incline cost multiplier (P7b, unwired here)', () => {
    expect(SLOPE_RAIL_COST_MULTIPLIER).toBe(2);
  });
});
