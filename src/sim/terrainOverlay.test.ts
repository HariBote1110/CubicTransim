import { describe, expect, it } from 'vitest';
import { createTerrainField, fieldFromMaps, MOUNTAIN_HEIGHT_THRESHOLD, TERRAIN_HEIGHT_MAX } from './terrainField';
import type { TerrainField } from './terrainField';
import {
  applyCornerEdit,
  applyCornerFill,
  cornerDiffsFromField,
  buildEditBlockers,
  createEditedTerrainField,
  deserialiseCornerDiffs,
  isEditedTerrainField,
  overlayChunkRefs,
  OVERLAY_CHUNK_SIZE,
  rectCells,
  serialiseCornerDiffs,
  type CornerDiffs,
  type EditBlockers,
} from './terrainOverlay';
import { toKey, DIR } from '../utils';
import type { CellData } from '../types';

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

describe('isEditedTerrainField', () => {
  it('returns true for a field created by createEditedTerrainField', () => {
    expect(isEditedTerrainField(createEditedTerrainField(flatField))).toBe(true);
  });

  it('returns false for a plain TerrainField without diffs', () => {
    expect(isEditedTerrainField(flatField)).toBe(false);
  });
});

describe('applyCornerFill', () => {
  it('raises only the corners below the target height (single low corner of a cell)', () => {
    // セル(0,0)=[nw,ne,sw,se]=[1,1,1,1]相当のところ、sw(0,1)だけ0(単一コーナーのくぼみ)。
    // OVERLAY_CHUNK_SIZE=64・チャンク(0,0)内なので localIndex = x*64 + z。
    const diffs: CornerDiffs = new Map([['0,0', new Map([
      [0 * OVERLAY_CHUNK_SIZE + 0, 1],
      [1 * OVERLAY_CHUNK_SIZE + 0, 1],
      [0 * OVERLAY_CHUNK_SIZE + 1, 0],
      [1 * OVERLAY_CHUNK_SIZE + 1, 1],
    ])]]);
    const editedField = createEditedTerrainField(flatField, diffs);
    const result = applyCornerFill(flatField, editedField, [{ x: 0, z: 1, height: 1 }], openBlockers(100));
    expect(result.changedCorners).toBe(1);
    expect(result.field.cornerHeightAt(0, 1)).toBe(1);
    // 他の3隅は元々1のまま変化しない。
    expect(result.field.cornerHeightAt(0, 0)).toBe(1);
    expect(result.field.cornerHeightAt(1, 0)).toBe(1);
    expect(result.field.cornerHeightAt(1, 1)).toBe(1);
  });

  it('is a no-op when the target height is not higher than the current height', () => {
    const editedField = createEditedTerrainField(flatField);
    const result = applyCornerFill(flatField, editedField, [{ x: 0, z: 0, height: 0 }], openBlockers(100));
    expect(result.field).toBe(editedField);
    expect(result.changedCorners).toBe(0);
  });

  it('is a no-op(same reference) when the fill would touch a blocked cell', () => {
    const editedField = createEditedTerrainField(flatField);
    const blockers: EditBlockers = { isCellBlocked: (x, z) => x === 0 && z === 0 };
    const result = applyCornerFill(flatField, editedField, [{ x: 0, z: 0, height: 1 }], blockers);
    expect(result.field).toBe(editedField);
    expect(result.changedCorners).toBe(0);
  });

  it('propagates the 1-Lipschitz constraint outward like raise mode', () => {
    const editedField = createEditedTerrainField(flatField);
    const result = applyCornerFill(flatField, editedField, [{ x: 0, z: 0, height: 2 }], openBlockers(100));
    expect(result.field.cornerHeightAt(0, 0)).toBe(2);
    // 隣接コーナーは段差1以下まで引き上げられる。
    expect(result.field.cornerHeightAt(1, 0)).toBe(1);
    expect(result.field.cornerHeightAt(-1, 0)).toBe(1);
    expect(result.field.cornerHeightAt(0, 1)).toBe(1);
    expect(result.field.cornerHeightAt(0, -1)).toBe(1);
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

describe('overlayChunkRefs', () => {
  const noBlockers: EditBlockers = { isCellBlocked: () => false };

  it('編集されていないチャンクは空配列を返す', () => {
    const diffs: CornerDiffs = new Map();
    const refs = overlayChunkRefs(diffs, { x0: 0, x1: 31, z0: 0, z1: 31 });
    expect(refs).toEqual([]);
  });

  it('重なる範囲を編集した後は参照を1件返す', () => {
    const base = createEditedTerrainField(flatField);
    const result = applyCornerEdit(flatField, base, { a: { x: 1, z: 1 }, b: { x: 2, z: 2 } }, 'raise', noBlockers);
    const refs = overlayChunkRefs(result.field.diffs, { x0: 0, x1: 31, z0: 0, z1: 31 });
    expect(refs.length).toBe(1);
  });

  it('無関係な遠方チャンクを編集しても参照は変わらない(疎性・チャンク独立性)', () => {
    let field = createEditedTerrainField(flatField);
    const before = overlayChunkRefs(field.diffs, { x0: 0, x1: 31, z0: 0, z1: 31 });
    expect(before).toEqual([]);

    const result = applyCornerEdit(
      flatField, field, { a: { x: 500, z: 500 }, b: { x: 501, z: 501 } }, 'raise', noBlockers,
    );
    field = result.field;
    const after = overlayChunkRefs(field.diffs, { x0: 0, x1: 31, z0: 0, z1: 31 });
    expect(after).toEqual([]);
  });

  it('同じ編集内容でも再編集すると参照(オブジェクト同一性)が変わる(immutable replace)', () => {
    const base = createEditedTerrainField(flatField);
    const first = applyCornerEdit(flatField, base, { a: { x: 1, z: 1 }, b: { x: 2, z: 2 } }, 'raise', noBlockers);
    const refsAfterFirst = overlayChunkRefs(first.field.diffs, { x0: 0, x1: 31, z0: 0, z1: 31 });

    const second = applyCornerEdit(
      flatField, first.field, { a: { x: 3, z: 3 }, b: { x: 4, z: 4 } }, 'raise', noBlockers,
    );
    const refsAfterSecond = overlayChunkRefs(second.field.diffs, { x0: 0, x1: 31, z0: 0, z1: 31 });

    expect(refsAfterSecond[0]).not.toBe(refsAfterFirst[0]);
  });
});

describe('buildEditBlockers', () => {
  const baseField = createTerrainField(1, 45);
  // TownTileIndexはhas/getの2メソッドのみを要求する。テストではhasだけを実データにし、
  // getはこのヘルパーで満たす(buildEditBlockersはhasしか呼ばない)。
  const townTileIndex = (has: (key: string) => boolean) => ({ has, get: () => undefined });

  it('halfExtentの範囲外はブロックされる', () => {
    const blockers = buildEditBlockers({
      halfExtent: 45, railMap: new Map(), townTileIndex: townTileIndex(() => false), baseField,
    });
    expect(blockers.isCellBlocked(46, 0)).toBe(true);
    expect(blockers.isCellBlocked(0, -46)).toBe(true);
    expect(blockers.isCellBlocked(45, 45)).toBe(false);
  });

  it('railMapに登録済みのセルはブロックされる', () => {
    const railMap = new Map<string, CellData>([[toKey(2, 2), { type: 'rail', connections: 1 }]]);
    const blockers = buildEditBlockers({
      halfExtent: 45, railMap, townTileIndex: townTileIndex(() => false), baseField,
    });
    expect(blockers.isCellBlocked(2, 2)).toBe(true);
    expect(blockers.isCellBlocked(3, 3)).toBe(false);
  });

  it('町タイル索引がhasを返すセルはブロックされる', () => {
    const blockers = buildEditBlockers({
      halfExtent: 45, railMap: new Map(), townTileIndex: townTileIndex(key => key === toKey(5, 5)), baseField,
    });
    expect(blockers.isCellBlocked(5, 5)).toBe(true);
    expect(blockers.isCellBlocked(6, 6)).toBe(false);
  });

  it('水域セルはブロックされる', () => {
    const terrain = new Map([[toKey(7, 7), 'water' as const]]);
    const waterField = fieldFromMaps(new Map(), terrain, 45);
    const blockers = buildEditBlockers({
      halfExtent: 45, railMap: new Map(), townTileIndex: townTileIndex(() => false), baseField: waterField,
    });
    expect(blockers.isCellBlocked(7, 7)).toBe(true);
    expect(blockers.isCellBlocked(8, 8)).toBe(false);
  });

  it('P8a: 地下線しか無い(地平のconnectionsが0の)セルもブロックされる(railMap.hasが層を問わず判定するため)', () => {
    // applyUndergroundPathは地下専用セルでも{type:'rail', connections:0, uppers:{-1:{...}}}を
    // railMapへ登録するため、buildEditBlockersの既存のrailMap.hasチェックだけで
    // 「地下線があるセルは地形編集をブロックする」(design doc 4.)が自動的に成立する。
    const railMap = new Map<string, CellData>([
      [toKey(9, 9), { type: 'rail', connections: 0, uppers: { [-1]: { connections: DIR.E } } }],
    ]);
    const blockers = buildEditBlockers({
      halfExtent: 45, railMap, townTileIndex: townTileIndex(() => false), baseField,
    });
    expect(blockers.isCellBlocked(9, 9)).toBe(true);
  });
});

describe('createEditedTerrainField batch corner grid (P9a)', () => {
  it('cornerGridFor(base+overlay) matches per-corner cornerHeightAt over random windows with edits applied', () => {
    const base = createTerrainField(11, HALF_EXTENT);
    let field = createEditedTerrainField(base);
    const blockers: EditBlockers = { isCellBlocked: () => false };
    // 複数箇所を盛土して疎なdiffsを作る(境界含む複数チャンクにまたがるように散らす)。
    const edits: Array<{ a: { x: number; z: number }; b: { x: number; z: number } }> = [
      { a: { x: 0, z: 0 }, b: { x: 3, z: 3 } },
      { a: { x: 60, z: -60 }, b: { x: 63, z: -57 } },
      { a: { x: -200, z: 200 }, b: { x: -197, z: 203 } },
    ];
    for (const rect of edits) {
      const result = applyCornerEdit(base, field, rect, 'raise', blockers);
      field = result.field;
    }
    expect(field.diffs.size).toBeGreaterThan(0);

    const rng = mulberry32(123);
    for (let trial = 0; trial < 15; trial++) {
      const x0 = Math.floor((rng() - 0.5) * 800);
      const z0 = Math.floor((rng() - 0.5) * 800);
      const w = 1 + Math.floor(rng() * 40);
      const h = 1 + Math.floor(rng() * 40);
      const grid = field.cornerGridFor!(x0, z0, w, h);
      const gh = h + 1;
      for (let lx = 0; lx <= w; lx++) {
        for (let lz = 0; lz <= h; lz++) {
          expect(grid[lx * gh + lz]).toBe(field.cornerHeightAt(x0 + lx, z0 + lz));
        }
      }
    }
  });

  it('cornerGridFor exactly covers a window straddling an edited corner', () => {
    const base = createTerrainField(11, HALF_EXTENT);
    let field = createEditedTerrainField(base);
    const blockers: EditBlockers = { isCellBlocked: () => false };
    const result = applyCornerEdit(base, field, { a: { x: 10, z: 10 }, b: { x: 10, z: 10 } }, 'raise', blockers);
    field = result.field;
    expect(result.changedCorners).toBeGreaterThan(0);

    const grid = field.cornerGridFor!(5, 5, 10, 10);
    const gh = 11;
    for (let lx = 0; lx <= 10; lx++) {
      for (let lz = 0; lz <= 10; lz++) {
        expect(grid[lx * gh + lz]).toBe(field.cornerHeightAt(5 + lx, 5 + lz));
      }
    }
  });

  it('waterCornerGridFor delegates to the base field unaffected by edits', () => {
    const base = createTerrainField(11, HALF_EXTENT);
    const field = createEditedTerrainField(base);
    const grid = field.waterCornerGridFor!(0, 0, 32, 32);
    const baseGrid = base.waterCornerGridFor!(0, 0, 32, 32);
    expect(Array.from(grid)).toEqual(Array.from(baseGrid));
  });
});

describe('cornerDiffsFromField', () => {
  it('reproduces the source field through createEditedTerrainField', () => {
    const source = createTerrainField(4242, 6);
    const diffs = cornerDiffsFromField(source, 6);
    const rebuilt = createEditedTerrainField(createTerrainField(1, 6), diffs);
    for (let z = -6; z <= 6; z++) {
      for (let x = -6; x <= 6; x++) {
        expect(rebuilt.cornerHeightAt(x, z)).toBe(source.cornerHeightAt(x, z));
      }
    }
  });

  it('covers the corner ring one past the last cell on both axes', () => {
    const source = createTerrainField(7, 3);
    const diffs = cornerDiffsFromField(source, 3);
    const rebuilt = createEditedTerrainField(createTerrainField(99, 3), diffs);
    expect(rebuilt.cornerHeightAt(4, 4)).toBe(source.cornerHeightAt(4, 4));
    expect(rebuilt.cornerHeightAt(-3, -3)).toBe(source.cornerHeightAt(-3, -3));
  });

  // R4末: wgpuレンダラー側に、コーナー座標の絶対値が大きい範囲までオーバーレイを
  // 書き出すとタイル生成が標高を正しく反映しなくなる不具合が見つかった(ブラウザ実機、
  // progress/openttd-tunnel-portals.md参照)。z方向に依存しない手組み地形(山岳
  // トンネルの尾根など)では、実際に使う範囲だけへ絞れるようboundsを渡せるようにする。
  it('bounds を渡すと、その矩形の外側には一切書き出さない', () => {
    const source = createTerrainField(4242, 20);
    const diffs = cornerDiffsFromField(source, 20, { x0: -3, x1: 3, z0: -2, z1: 2 });
    const rebuilt = createEditedTerrainField(createTerrainField(1, 20), diffs);
    // 範囲内はsourceの値を反映する
    expect(rebuilt.cornerHeightAt(0, 0)).toBe(source.cornerHeightAt(0, 0));
    // 範囲外はbase(1)のまま、sourceの値では上書きされない
    expect(rebuilt.cornerHeightAt(10, 10)).toBe(createTerrainField(1, 20).cornerHeightAt(10, 10));
  });

  it('bounds省略時は従来どおりhalfExtent全域を書き出す(無回帰)', () => {
    const source = createTerrainField(4242, 6);
    const withBounds = cornerDiffsFromField(source, 6, { x0: -6, x1: 7, z0: -6, z1: 7 });
    const withoutBounds = cornerDiffsFromField(source, 6);
    const rebuiltA = createEditedTerrainField(createTerrainField(1, 6), withBounds);
    const rebuiltB = createEditedTerrainField(createTerrainField(1, 6), withoutBounds);
    for (let z = -6; z <= 6; z++) {
      for (let x = -6; x <= 6; x++) {
        expect(rebuiltA.cornerHeightAt(x, z)).toBe(rebuiltB.cornerHeightAt(x, z));
      }
    }
  });
});
