// terrainField(コーナー格子の純関数地形)に対する疎な編集オーバーレイと、
// OpenTTD風のコーナー地形編集(盛土/切土)。React/THREE には依存しない。
// 詳細な設計判断は progress/16k-map-architecture.md の「P2実装メモ」参照。
//
// 旧terrainEdit.ts(セル単位の±1・全域Mapクローン、P6で削除)を置き換えた経路。
// P3でuseGameLogic.ts/GameUI.tsxの建設・地形編集経路をこちらへ載せ替え済み。

import type { CellCorners, TerrainField, TerrainKind } from './terrainField';
import {
  MOUNTAIN_HEIGHT_THRESHOLD, TERRAIN_HEIGHT_MAX,
  cornerGridFor as cornerGridForModule, waterCornerGridFor as waterCornerGridForModule,
} from './terrainField';
import { toKey } from '../utils';
import type { CellData } from '../types';
import type { TownTileIndex } from './townTiles';

export type TerrainEditMode = 'raise' | 'lower';

export interface Pos {
  x: number;
  z: number;
}

// --- 疎な編集差分ストア(コーナー格子・チャンク分割) ---
//
// チャンクサイズ。コーナー座標を OVERLAY_CHUNK_SIZE 単位のグリッドに割り当てる。
export const OVERLAY_CHUNK_SIZE = 64;

/**
 * コーナー標高の上書き差分。`chunkKey -> (localIndex -> height)` の2段構成。
 *
 * 実装選択(Map<number, number> per chunk、Int8Array ではない): 編集は「触れたコーナーだけ」
 * を持つ真の疎データであってほしい(1回の盛土/切土は数十〜数百コーナー程度)。
 * Int8Array を使うと1チャンクにつき OVERLAY_CHUNK_SIZE^2 = 4096 要素を確保する必要があり、
 * 「チャンクの隅を1つだけ編集した」場合でもチャンク全体を初期化するコストと、
 * シリアライズ時に「非ゼロ要素を探すために全4096要素を走査する」コストを払うことになる。
 * per-chunk Map ならチャンク内でも編集されたコーナーの件数だけを保持・列挙でき、
 * どちらの向きでも O(編集件数) を維持できる。標高は 0..TERRAIN_HEIGHT_MAX(=10)の
 * 小さな整数なので Map のオーバーヘッドは許容範囲。
 */
export type CornerDiffs = Map<string, Map<number, number>>;

/** createEditedTerrainField が返す、diffs へのアクセスを備えた TerrainField。 */
export interface EditedTerrainField extends TerrainField {
  readonly diffs: CornerDiffs;
}

const chunkCoordOf = (v: number): number => Math.floor(v / OVERLAY_CHUNK_SIZE);
const chunkKeyOf = (cx: number, cz: number): string => `${cx},${cz}`;
const localIndexOf = (x: number, z: number, cx: number, cz: number): number => {
  const lx = x - cx * OVERLAY_CHUNK_SIZE;
  const lz = z - cz * OVERLAY_CHUNK_SIZE;
  return lx * OVERLAY_CHUNK_SIZE + lz;
};

const getOverride = (diffs: CornerDiffs, x: number, z: number): number | undefined => {
  const cx = chunkCoordOf(x);
  const cz = chunkCoordOf(z);
  const chunk = diffs.get(chunkKeyOf(cx, cz));
  if (!chunk) return undefined;
  return chunk.get(localIndexOf(x, z, cx, cz));
};

/**
 * base(基底の純関数field)と diffs(疎な上書き差分)を合成した TerrainField を作る。
 * cornerHeightAt はオーバーライド→基底の順に引く。cellCornerHeights/cellHeightAt/
 * terrainTypeAt はすべてこの合成済みコーナーから導出する(オーバーレイ適用後の値で
 * mountain/grass が決まる = 盛土でmountain化・切土でgrass復帰の両方が成立する)。
 *
 * water だけは例外: water はベースノイズ由来のプロパティであり、編集では作られない
 * (applyCornerEdit のブロック規則が水域に触れる編集を常にno-opにするため、水セルの
 * 判定は常に基底の terrainTypeAt に委ねてよい)。
 */
export function createEditedTerrainField(base: TerrainField, diffs: CornerDiffs = new Map()): EditedTerrainField {
  const cornerHeightAt = (x: number, z: number): number => {
    const ix = Math.round(x);
    const iz = Math.round(z);
    const override = getOverride(diffs, ix, iz);
    return override ?? base.cornerHeightAt(ix, iz);
  };

  const cellCornerHeights = (x: number, z: number): CellCorners => [
    cornerHeightAt(x, z),
    cornerHeightAt(x + 1, z),
    cornerHeightAt(x, z + 1),
    cornerHeightAt(x + 1, z + 1),
  ];

  const cellHeightAt = (x: number, z: number): number => {
    const [nw, ne, sw, se] = cellCornerHeights(x, z);
    return Math.min(nw, ne, sw, se);
  };

  const terrainTypeAt = (x: number, z: number): TerrainKind => {
    if (base.terrainTypeAt(x, z) === 'water') return 'water';
    return cellHeightAt(x, z) >= MOUNTAIN_HEIGHT_THRESHOLD ? 'mountain' : 'grass';
  };

  // P9a: バッチAPI。base.cornerGridFor(未実装ならcornerHeightAtへの逐次フォールバック、
  // cornerGridForヘルパー経由)で下地格子を1回作り、その上にdiffsの疎な上書きだけを
  // 重ねる。overlayChunkRefsと同じ考え方で、窓に重なるオーバーレイチャンクだけを
  // 走査するため、コスト = 下地の1回評価 + 触れられたコーナー数(疎)に収まる。
  const cornerGridForImpl = (x0: number, z0: number, w: number, h: number): Uint8Array => {
    const grid = cornerGridForModule(base, x0, z0, w, h);
    if (diffs.size === 0) return grid;
    const gh = h + 1;
    const cx0 = chunkCoordOf(x0);
    const cx1 = chunkCoordOf(x0 + w);
    const cz0 = chunkCoordOf(z0);
    const cz1 = chunkCoordOf(z0 + h);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const chunk = diffs.get(chunkKeyOf(cx, cz));
        if (!chunk) continue;
        for (const [localIndex, height] of chunk) {
          const lxAbs = Math.floor(localIndex / OVERLAY_CHUNK_SIZE);
          const lzAbs = localIndex % OVERLAY_CHUNK_SIZE;
          const x = cx * OVERLAY_CHUNK_SIZE + lxAbs;
          const z = cz * OVERLAY_CHUNK_SIZE + lzAbs;
          const lx = x - x0;
          const lz = z - z0;
          if (lx < 0 || lx > w || lz < 0 || lz > h) continue;
          grid[lx * gh + lz] = height;
        }
      }
    }
    return grid;
  };

  // water(湖)は編集で作られない(applyCornerEditのブロック規則が水域を常にno-opにする)ため、
  // 常に基底fieldのwater判定に委ねられる(terrainTypeAtの実装と同じ前提)。
  const waterCornerGridForImpl = (x0: number, z0: number, w: number, h: number): Uint8Array =>
    waterCornerGridForModule(base, x0, z0, w, h);

  return {
    cornerHeightAt, cellCornerHeights, cellHeightAt, terrainTypeAt, diffs,
    cornerGridFor: cornerGridForImpl,
    waterCornerGridFor: waterCornerGridForImpl,
  };
}

// --- コーナー地形編集(盛土/切土) ---

/** 変化したコーナー1件あたりのコスト単位(経済への配線はP2ではまだ行わない)。 */
export const TERRAIN_EDIT_COST_PER_CORNER = 1;

/**
 * 編集を拒否するかどうかの判定。rail/station/depot/signal・町タイル(家・道路)・水域・
 * 範囲外のすべてを1つの述語に集約する(terrainEdit.ts のブロック規則と同じ4条件だが、
 * 「セルが編集を受け入れられないか」という1つの問いに統一することで、この関数側は
 * railMap/townTiles/halfExtent の型を一切知らずに済む)。呼び出し側(消費層)が
 * 実際のゲーム状態からこの述語を組み立てる。
 */
export interface EditBlockers {
  isCellBlocked(x: number, z: number): boolean;
}

/**
 * ゲーム状態(railMap・町タイル索引・halfExtent・基底field)から{@link EditBlockers}を
 * 組み立てる共有ヘルパー。P3時点ではuseGameLogic.tsとGameUI.tsx/buildPreviewの両方に
 * 同じ4条件(範囲外/rail・station・depot・signal/町タイル/水域)の組み立てコードが
 * 重複していた(progress/16k-map-architecture.md「P3実装メモ」参照)。以後はこの関数を
 * 両方から呼ぶ。
 */
export function buildEditBlockers(params: {
  halfExtent: number;
  railMap: Map<string, CellData>;
  townTileIndex: TownTileIndex;
  baseField: TerrainField;
}): EditBlockers {
  const { halfExtent, railMap, townTileIndex, baseField } = params;
  return {
    isCellBlocked: (x, z) =>
      x < -halfExtent || x > halfExtent || z < -halfExtent || z > halfExtent ||
      railMap.has(toKey(x, z)) ||
      townTileIndex.has(toKey(x, z)) ||
      baseField.terrainTypeAt(x, z) === 'water',
  };
}

export interface CornerEditResult {
  field: EditedTerrainField;
  changedCorners: number;
}

const NEIGHBOUR_OFFSETS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// あるコーナー(cx,cz)を4隅のどれかに持つセル4つのオフセット。
const TOUCHING_CELL_OFFSETS: ReadonlyArray<[number, number]> = [
  [0, 0],
  [-1, 0],
  [0, -1],
  [-1, -1],
];

/** 対角2点が囲む矩形内の全セル(x昇順→z昇順)。terrainEdit.ts の rectCells と同じ規約。 */
export function rectCells(a: Pos, b: Pos): Pos[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const z0 = Math.min(a.z, b.z);
  const z1 = Math.max(a.z, b.z);
  const cells: Pos[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      cells.push({ x, z });
    }
  }
  return cells;
}

const cornerKey = (x: number, z: number): string => `${x},${z}`;
const parseCornerKey = (key: string): Pos => {
  const [x, z] = key.split(',').map(Number);
  return { x, z };
};

/**
 * 選択セル(rectで矩形指定)の4隅コーナーすべてを1段盛土/切土し、コーナー格子上の
 * 1-Lipschitzを方向つきBFS伝播で回復する。terrainEdit.ts のセル版アルゴリズムを
 * コーナー格子に移植したもの(伝播の考え方はそのまま、対象がセルからコーナーに変わる)。
 *
 * ブロック規則: 変化した(伝播による波及を含む)コーナーを4隅に持つセルのいずれかが
 * blockers.isCellBlocked を満たすなら、編集全体をno-opとして同一参照の field を返す
 * (部分適用はしない。CubicTransim全体の「同一参照no-op」規約に合わせる)。
 */
export function applyCornerEdit(
  base: TerrainField,
  editedField: EditedTerrainField,
  rect: { a: Pos; b: Pos },
  mode: TerrainEditMode,
  blockers: EditBlockers
): CornerEditResult {
  const noop: CornerEditResult = { field: editedField, changedCorners: 0 };

  const cells = rectCells(rect.a, rect.b);
  if (cells.length === 0) return noop;

  const isCornerBlocked = (cx: number, cz: number): boolean => {
    for (const [dx, dz] of TOUCHING_CELL_OFFSETS) {
      if (blockers.isCellBlocked(cx + dx, cz + dz)) return true;
    }
    return false;
  };

  const updated = new Map<string, number>();
  const heightAt = (x: number, z: number): number => updated.get(cornerKey(x, z)) ?? editedField.cornerHeightAt(x, z);

  // 1. 選択セルの4隅コーナーを±1段する(上限・下限のコーナーは変化なしのまま許容)。
  const queue: Pos[] = [];
  const seenCorners = new Set<string>();
  for (const cell of cells) {
    for (const [ox, oz] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const cx = cell.x + ox;
      const cz = cell.z + oz;
      const key = cornerKey(cx, cz);
      if (seenCorners.has(key)) continue;
      seenCorners.add(key);
      const current = heightAt(cx, cz);
      const target = mode === 'raise' ? Math.min(TERRAIN_HEIGHT_MAX, current + 1) : Math.max(0, current - 1);
      if (target !== current) {
        if (isCornerBlocked(cx, cz)) return noop;
        updated.set(key, target);
        queue.push({ x: cx, z: cz });
      }
    }
  }
  if (updated.size === 0) return noop;

  // 2. 段差1以下への伝播(BFS)。raiseは隣接コーナーをh-1まで引き上げ、lowerはh+1まで
  //    引き下げる。編集前が1-Lipschitzなら各コーナーの変化は±1段で収まる。
  while (queue.length > 0) {
    const { x, z } = queue.shift()!;
    const h = heightAt(x, z);
    for (const [dx, dz] of NEIGHBOUR_OFFSETS) {
      const nx = x + dx;
      const nz = z + dz;
      const nHeight = heightAt(nx, nz);
      if (mode === 'raise' && nHeight < h - 1) {
        if (isCornerBlocked(nx, nz)) return noop;
        updated.set(cornerKey(nx, nz), h - 1);
        queue.push({ x: nx, z: nz });
      } else if (mode === 'lower' && nHeight > h + 1) {
        if (isCornerBlocked(nx, nz)) return noop;
        updated.set(cornerKey(nx, nz), h + 1);
        queue.push({ x: nx, z: nz });
      }
    }
  }

  // 3. 確定: 変化したコーナーだけ diffs へ反映する。基底値へ戻ったコーナーは
  //    オーバーライドを削除する(疎性維持: 編集で往復して元に戻った箇所を残さない)。
  const touchedChunks = new Set<string>();
  const nextDiffs: CornerDiffs = new Map(editedField.diffs);
  const ensureMutableChunk = (cx: number, cz: number): Map<number, number> => {
    const key = chunkKeyOf(cx, cz);
    if (!touchedChunks.has(key)) {
      const existing = nextDiffs.get(key);
      nextDiffs.set(key, existing ? new Map(existing) : new Map());
      touchedChunks.add(key);
    }
    return nextDiffs.get(key)!;
  };

  let changedCorners = 0;
  for (const [key, h] of updated) {
    const { x, z } = parseCornerKey(key);
    const original = editedField.cornerHeightAt(x, z);
    if (h === original) continue;
    changedCorners++;
    const cx = chunkCoordOf(x);
    const cz = chunkCoordOf(z);
    const chunk = ensureMutableChunk(cx, cz);
    if (h === base.cornerHeightAt(x, z)) {
      chunk.delete(localIndexOf(x, z, cx, cz));
      if (chunk.size === 0) nextDiffs.delete(chunkKeyOf(cx, cz));
    } else {
      chunk.set(localIndexOf(x, z, cx, cz), h);
    }
  }
  if (changedCorners === 0) return noop;

  return { field: createEditedTerrainField(base, nextDiffs), changedCorners };
}

// --- 描画チャンクキャッシュ向けのリビジョン参照(P4) ---

/**
 * セル範囲([x0,x1]×[z0,z1])が持つ4隅コーナー(境界を含めるため x1+1/z1+1 まで)に
 * 重なりうるオーバーレイチャンク(OVERLAY_CHUNK_SIZE=64単位)のサブMapを、
 * 存在するものだけ集めて返す。
 *
 * 用途: render/terrainChunks.tsのチャンク描画キャッシュ(TerrainBlocks)が
 * 「このチャンクの地形編集差分は変わったか」を判定するためのキー。P2実装メモに
 * ある通り、applyCornerEditは編集で触れたオーバーレイチャンクだけ新しいMapへ
 * 差し替える(immutable replace)ので、このサブMapの参照が前回と同一かどうかを
 * 比較するだけで「このチャンクに影響する編集があったか」をO(重なるオーバーレイ
 * チャンク数)で判定できる(diffs全体の走査やdeep equalは不要)。
 * 戻り値の配列そのものの参照は呼び出しのたびに新しく作られるため、比較は
 * 呼び出し側が要素ごと(浅い比較)で行うこと。
 */
export function overlayChunkRefs(
  diffs: CornerDiffs,
  cellBounds: { x0: number; x1: number; z0: number; z1: number },
): ReadonlyArray<Map<number, number>> {
  const cx0 = chunkCoordOf(cellBounds.x0);
  const cx1 = chunkCoordOf(cellBounds.x1 + 1);
  const cz0 = chunkCoordOf(cellBounds.z0);
  const cz1 = chunkCoordOf(cellBounds.z1 + 1);

  const refs: Map<number, number>[] = [];
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const chunk = diffs.get(chunkKeyOf(cx, cz));
      if (chunk) refs.push(chunk);
    }
  }
  return refs;
}

// --- シリアライズ(将来の SaveData v15 向け) ---

export type SerialisedCornerDiffs = Array<[string, Array<[number, number]>]>;

/** CornerDiffs を JSON 化可能な配列表現に変換する。 */
export function serialiseCornerDiffs(diffs: CornerDiffs): SerialisedCornerDiffs {
  const out: SerialisedCornerDiffs = [];
  for (const [chunkKey, chunk] of diffs) {
    out.push([chunkKey, Array.from(chunk.entries())]);
  }
  return out;
}

/** serialiseCornerDiffs の逆変換。 */
export function deserialiseCornerDiffs(data: SerialisedCornerDiffs): CornerDiffs {
  const diffs: CornerDiffs = new Map();
  for (const [chunkKey, entries] of data) {
    diffs.set(chunkKey, new Map(entries));
  }
  return diffs;
}

/** cornerDiffsFromField が書き出す範囲を絞るための矩形(コーナー座標、両端含む)。 */
export interface CornerDiffsBounds {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * TerrainField のコーナー標高を、マップ全域ぶんの CornerDiffs として書き出す(R4d)。
 *
 * 用途: デバッグシナリオが「シードから導けない手組みの地形」(useGameLogic の
 * debugFieldOverride)を使うと、シード+halfExtent しか知らない wgpu レンダラーが
 * 別の地形を描いてしまい、線路や駅が丘に埋もれて見えなくなる。three.js 退役後は
 * それが唯一の描画経路になるため、上書きfieldをオーバーレイ差分へ焼き直して
 * wasm 側へ転送できるようにする。
 *
 * 制約: オーバーレイはコーナー標高だけを表現するので、`cellCornerHeights` を
 * 直接実装して4隅を不揃いにするタイプの擬似field(山岳トンネルのシナリオの尾根)は
 * 再現できない。その場合は cornerHeightAt の値(=平坦)が使われる。
 *
 * `bounds` を渡すと、その矩形の外側は一切書き出さない(省略時は従来どおりマップ全域)。
 * これは転送量を減らすための最適化であり、大きなマップで地形の手組み範囲が狭い
 * シナリオなどに使う。かつて「コーナー座標の絶対値がおよそ±20/±5を超える範囲まで
 * オーバーレイを書き出すと、wgpu側のタイル生成が正しく標高を反映しなくなる」という
 * レンダラー側の不具合が疑われていたが、ネイティブ・wasm双方でのバイト単位の
 * 検証により否定された。実際の原因は「zに依存しない長い尾根が真等角投影で
 * ほぼエッジオンに見え、平坦な色帯にしか見えない」光学的な誤診断だった。
 * 調査の詳細は progress/wgpu-corner-override-z-investigation.md を参照。
 */
export function cornerDiffsFromField(
  field: TerrainField,
  halfExtent: number,
  bounds?: CornerDiffsBounds,
): CornerDiffs {
  const x0 = bounds?.x0 ?? -halfExtent;
  const x1 = bounds?.x1 ?? halfExtent + 1;
  const z0 = bounds?.z0 ?? -halfExtent;
  const z1 = bounds?.z1 ?? halfExtent + 1;
  const diffs: CornerDiffs = new Map();
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const cx = chunkCoordOf(x);
      const cz = chunkCoordOf(z);
      const key = chunkKeyOf(cx, cz);
      let chunk = diffs.get(key);
      if (!chunk) {
        chunk = new Map();
        diffs.set(key, chunk);
      }
      chunk.set(localIndexOf(x, z, cx, cz), field.cornerHeightAt(x, z));
    }
  }
  return diffs;
}
