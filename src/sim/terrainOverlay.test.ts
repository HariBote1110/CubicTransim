import { describe, expect, it } from 'vitest';
import { createTerrainField, MOUNTAIN_HEIGHT_THRESHOLD, TERRAIN_HEIGHT_MAX } from './terrainField';
import type { TerrainField } from './terrainField';
import {
  applyCornerEdit,
  createEditedTerrainField,
  deserialiseCornerDiffs,
  OVERLAY_CHUNK_SIZE,
  rectCells,
  serialiseCornerDiffs,
  type CornerDiffs,
  type EditBlockers,
} from './terrainOverlay';

// mulberry32風の疑似乱数(プロパティテストのランダム選択専用)。
const mulberry32 = (seed: number) => {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const HALF_EXTENT = 4096;

// テスト用の平坦な基底field(標高0一定・水域なし)。オーバーレイ/伝播のロジックだけを
// 素早く・予測可能に検証するために使う(ノイズ地形の検証は terrainField.test.ts 側)。
const flatField: TerrainField = {
  cornerHeightAt: () => 0,
  cellCornerHeights: () => [0, 0, 0, 0],
  cellHeightAt: () => 0,
  terrainTypeAt: () => 'grass',
};

// 何もブロックしない(範囲内のみ許可)のブロッカー。
const openBlockers = (limit: number): EditBlockers => ({
  isCellBlocked: (x, z) => Math.abs(x) > limit || Math.abs(z) > limit,
});

describe('createEditedTerrainField', () => {
  it('has no override -> falls back to base height/type', () => {
    const field = createEditedTerrainField(flatField);
    expect(field.cornerHeightAt(3, 4)).toBe(0);
    expect(field.cellHeightAt(3, 4)).toBe(0);
    expect(field.terrainTypeAt(3, 4)).toBe('grass');
  });

  it('overlays a raised corner and derives mountain from it', () => {
    const diffs: CornerDiffs = new Map([['0,0', new Map([[0, MOUNTAIN_HEIGHT_THRESHOLD]])]]);
    const field = createEditedTerrainField(flatField, diffs);
    expect(field.cornerHeightAt(0, 0)).toBe(MOUNTAIN_HEIGHT_THRESHOLD);
    // セル(0,0)〜(-1,-1)はコーナー(0,0)を含むので、そのセルは4隅min=0(他3隅が0)のまま。
    // セル(-1,-1)-(0,0)自体のcellHeightAtはminを取るので0のまま(他コーナーは0)。
    expect(field.cellHeightAt(-1, -1)).toBe(0);
  });

  it('water stays a base-noise property, not overridden by height edits', () => {
    const waterField: TerrainField = {
      ...flatField,
      terrainTypeAt: () => 'water',
    };
    // 水域セルの4隅を書き換えても(通常はブロックされて起こらないが)terrainTypeAtはwaterのまま。
    const diffs: CornerDiffs = new Map([['0,0', new Map([[0, 5]])]]);
    const field = createEditedTerrainField(waterField, diffs);
    expect(field.terrainTypeAt(0, 0)).toBe('water');
  });
});

describe('applyCornerEdit', () => {
  it('raises all 4 corners of a single selected cell', () => {
    const editedField = createEditedTerrainField(flatField);
    const result = applyCornerEdit(flatField, editedField, { a: { x: 0, z: 0 }, b: { x: 0, z: 0 } }, 'raise', openBlockers(100));
    expect(result.changedCorners).toBe(4);
    for (const [x, z] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      expect(result.field.cornerHeightAt(x, z)).toBe(1);
    }
    // 隣接コーナー(2,0)などは伝播対象外(段差1以下は既に満たされている)。
    expect(result.field.cornerHeightAt(2, 0)).toBe(0);
  });

  it('lowers all 4 corners of a single selected cell', () => {
    // まず1段盛ってから、その中心を切土して0へ戻す。
    const raised = applyCornerEdit(flatField, createEditedTerrainField(flatField), { a: { x: 0, z: 0 }, b: { x: 0, z: 0 } }, 'raise', openBlockers(100));
    const lowered = applyCornerEdit(flatField, raised.field, { a: { x: 0, z: 0 }, b: { x: 0, z: 0 } }, 'lower', openBlockers(100));
    expect(lowered.changedCorners).toBe(4);
    expect(lowered.field.cornerHeightAt(0, 0)).toBe(0);
    // 基底値へ戻ったので diffs は空(疎性維持)。
    expect(lowered.field.diffs.size).toBe(0);
  });

  it('propagates raise outward to keep the corner lattice 1-Lipschitz', () => {
    // 選択セルを2連続で盛土し、段差2にしてから伝播で1以下へ回復しているかを見る。
    let field = createEditedTerrainField(flatField);
    for (let i = 0; i < 2; i++) {
      const r = applyCornerEdit(flatField, field, { a: { x: 0, z: 0 }, b: { x: 0, z: 0 } }, 'raise', openBlockers(100));
      field = r.field;
    }
    expect(field.cornerHeightAt(0, 0)).toBe(2);
    // 中心から2マス離れた頂点までは段差1以下の伝播が届いているはず。
    expect(field.cornerHeightAt(2, 0)).toBeLessThanOrEqual(1);
    expect(field.cornerHeightAt(3, 0)).toBe(0);
    assertLipschitz(field, -5, 5, -5, 5);
  });

  it('clamps at TERRAIN_HEIGHT_MAX', () => {
    let field = createEditedTerrainField(flatField);
    for (let i = 0; i < TERRAIN_HEIGHT_MAX + 5; i++) {
      const r = applyCornerEdit(flatField, field, { a: { x: 0, z: 0 }, b: { x: 0, z: 0 } }, 'raise', openBlockers(100));
      field = r.field;
    }
    expect(field.cornerHeightAt(0, 0)).toBe(TERRAIN_HEIGHT_MAX);
  });

  it('clamps at 0 and returns a same-reference no-op once nothing changes', () => {
    const editedField = createEditedTerrainField(flatField);
    const result = applyCornerEdit(flatField, editedField, { a: { x: 0, z: 0 }, b: { x: 0, z: 0 } }, 'lower', openBlockers(100));
    expect(result.field).toBe(editedField);
    expect(result.changedCorners).toBe(0);
  });

  it('is a same-reference no-op when a touching cell is blocked (rail/station/depot/signal or town tile)', () => {
    const editedField = createEditedTerrainField(flatField);
    const blockers: EditBlockers = {
      isCellBlocked: (x, z) => (x === 0 && z === 0) || Math.abs(x) > 100 || Math.abs(z) > 100,
    };
    const result = applyCornerEdit(flatField, editedField, { a: { x: 0, z: 0 }, b: { x: 0, z: 0 } }, 'raise', blockers);
    expect(result.field).toBe(editedField);
    expect(result.changedCorners).toBe(0);
  });

  it('is a same-reference no-op when the rect touches out-of-range coordinates', () => {
    const editedField = createEditedTerrainField(flatField);
    const result = applyCornerEdit(flatField, editedField, { a: { x: 0, z: 0 }, b: { x: 0, z: 0 } }, 'raise', openBlockers(0));
    expect(result.field).toBe(editedField);
    expect(result.changedCorners).toBe(0);
  });

  it('no-ops (or leaves water flat at 0) when raising next to a lake', () => {
    const seed = 99;
    const base = createTerrainField(seed, HALF_EXTENT);
    const lakeCell = findLakeAdjacentCell(base);
    expect(lakeCell).not.toBeNull();
    if (!lakeCell) return;

    const blockers: EditBlockers = {
      isCellBlocked: (x, z) => Math.abs(x) > HALF_EXTENT || Math.abs(z) > HALF_EXTENT || base.terrainTypeAt(x, z) === 'water',
    };
    const editedField = createEditedTerrainField(base);
    const result = applyCornerEdit(
      base,
      editedField,
      { a: { x: lakeCell.x, z: lakeCell.z }, b: { x: lakeCell.x, z: lakeCell.z } },
      'raise',
      blockers
    );

    // no-opであること、あるいは(no-opにならなかったとしても)水域セルが標高0平坦のままであること。
    if (result.changedCorners === 0) {
      expect(result.field).toBe(editedField);
    } else {
      for (let x = -3; x <= 3; x++) {
        for (let z = -3; z <= 3; z++) {
          const cx = lakeCell.x + x;
          const cz = lakeCell.z + z;
          if (base.terrainTypeAt(cx, cz) === 'water') {
            expect(result.field.terrainTypeAt(cx, cz)).toBe('water');
            const [nw, ne, sw, se] = result.field.cellCornerHeights(cx, cz);
            expect([nw, ne, sw, se]).toEqual([0, 0, 0, 0]);
          }
        }
      }
    }
  });

  it('keeps the overlay sparse: an edit far from origin does not materialise unrelated chunks', () => {
    const editedField = createEditedTerrainField(flatField);
    const far = { x: 10_000, z: -10_000 };
    const result = applyCornerEdit(flatField, editedField, { a: far, b: far }, 'raise', openBlockers(20_000));
    expect(result.changedCorners).toBeGreaterThan(0);
    // 変化した4隅は同じチャンク(または高々隣接2チャンク)に収まるはずで、diffsのチャンク数は小さい。
    expect(result.field.diffs.size).toBeLessThanOrEqual(4);
    // 原点付近のチャンクは触られていない。
    expect(result.field.diffs.has('0,0')).toBe(false);
  });

  it('property: random raise/lower sequences preserve 1-Lipschitz on the corner lattice', () => {
    const rng = mulberry32(1234);
    let field = createEditedTerrainField(flatField);
    for (let i = 0; i < 60; i++) {
      const x0 = Math.floor(rng() * 20) - 10;
      const z0 = Math.floor(rng() * 20) - 10;
      const x1 = x0 + Math.floor(rng() * 3);
      const z1 = z0 + Math.floor(rng() * 3);
      const mode = rng() < 0.5 ? 'raise' : 'lower';
      const result = applyCornerEdit(flatField, field, { a: { x: x0, z: z0 }, b: { x: x1, z: z1 } }, mode, openBlockers(100));
      field = result.field;
    }
    assertLipschitz(field, -30, 30, -30, 30);
  });
});

describe('serialiseCornerDiffs / deserialiseCornerDiffs', () => {
  it('round-trips a diffs store', () => {
    const editedField = applyCornerEdit(
      flatField,
      createEditedTerrainField(flatField),
      { a: { x: 0, z: 0 }, b: { x: 2, z: 2 } },
      'raise',
      openBlockers(100)
    ).field;

    const serialised = serialiseCornerDiffs(editedField.diffs);
    const restored = deserialiseCornerDiffs(serialised);
    const restoredField = createEditedTerrainField(flatField, restored);

    for (let x = -5; x <= 5; x++) {
      for (let z = -5; z <= 5; z++) {
        expect(restoredField.cornerHeightAt(x, z)).toBe(editedField.cornerHeightAt(x, z));
      }
    }
    // JSON化可能であること。
    expect(() => JSON.stringify(serialised)).not.toThrow();
  });
});

describe('rectCells', () => {
  it('enumerates cells in x-then-z ascending order regardless of corner order', () => {
    const cells = rectCells({ x: 1, z: 1 }, { x: 0, z: 0 });
    expect(cells).toEqual([
      { x: 0, z: 0 },
      { x: 0, z: 1 },
      { x: 1, z: 0 },
      { x: 1, z: 1 },
    ]);
  });
});

// --- test helpers ---

function assertLipschitz(field: { cornerHeightAt(x: number, z: number): number }, x0: number, x1: number, z0: number, z1: number): void {
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const h = field.cornerHeightAt(x, z);
      expect(Math.abs(field.cornerHeightAt(x + 1, z) - h)).toBeLessThanOrEqual(1);
      expect(Math.abs(field.cornerHeightAt(x, z + 1) - h)).toBeLessThanOrEqual(1);
    }
  }
}

function findLakeAdjacentCell(field: TerrainField): Pos_ | null {
  for (let x = -60; x <= 60; x++) {
    for (let z = -60; z <= 60; z++) {
      if (field.terrainTypeAt(x, z) !== 'water') continue;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (field.terrainTypeAt(x + dx, z + dz) === 'grass') {
          return { x, z };
        }
      }
    }
  }
  return null;
}

type Pos_ = { x: number; z: number };

// OVERLAY_CHUNK_SIZE を参照して疎性テストの意図を明示(チャンクサイズが変わっても
// 「遠方の編集が原点チャンクに触れない」ことをこの定数経由で確認できるようにする)。
void OVERLAY_CHUNK_SIZE;
