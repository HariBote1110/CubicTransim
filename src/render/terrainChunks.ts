// 地形描画のチャンク分割(可視範囲駆動)に関する純粋なチャンク座標計算。
// React/THREE には依存しない。詳細な設計判断は progress/16k-map-architecture.md の
// 「P4実装メモ」参照。
//
// 目的: TerrainBlocks/Scenery の全域スキャン(-halfExtent..halfExtent の二重ループ)を
// 「カメラに映っている範囲のチャンクだけ」に絞り込み、描画コストをマップサイズ非依存
// (可視セル数のみに依存)にする。

export interface ChunkCoord {
  cx: number;
  cz: number;
}

export interface CellPos {
  x: number;
  z: number;
}

/** 1チャンクの一辺のセル数。 */
export const TERRAIN_CHUNK_SIZE = 32;

/** セル座標からチャンク座標へ(床除算)。 */
export const chunkCoordOf = (v: number): number => Math.floor(v / TERRAIN_CHUNK_SIZE);

/** チャンク座標を一意な文字列キーへ。Map のキーやキャッシュ識別に使う。 */
export const chunkKey = (cx: number, cz: number): string => `${cx},${cz}`;

/**
 * マップ(-halfExtent..halfExtent のセル)を覆うチャンク座標の範囲。
 * halfExtent が負・0でも(縮退マップ)必ず1チャンク分の範囲を返す。
 */
export function mapChunkBounds(halfExtent: number): { cx0: number; cx1: number; cz0: number; cz1: number } {
  const extent = Math.max(0, halfExtent);
  const norm = (v: number): number => v || 0; // -0 を +0 へ正規化する
  return {
    cx0: norm(chunkCoordOf(-extent)),
    cx1: norm(chunkCoordOf(extent)),
    cz0: norm(chunkCoordOf(-extent)),
    cz1: norm(chunkCoordOf(extent)),
  };
}

/**
 * カメラの注視点(セル座標)と可視半径(セル数)から、描画すべきチャンク座標の一覧を返す。
 *
 * - 注視点 ± viewRadiusCells のセル範囲をチャンク座標に変換し、さらに margin チャンクぶん
 *   外側へ広げる(スクロール時にチャンクの生成が追いつくよう先読みする)。
 * - マップ範囲(halfExtentから導くmapChunkBounds)へ必ずクランプする。カメラが範囲外を
 *   向いていても、存在しないチャンクを列挙しない。
 * - 戻り値はcx昇順→cz昇順(決定的な順序。テスト・キャッシュ差分検出をしやすくするため)。
 */
export function visibleChunkRange(
  cameraTargetCell: CellPos,
  viewRadiusCells: number,
  halfExtent: number,
  margin = 1,
): ChunkCoord[] {
  const radius = Math.max(0, viewRadiusCells);
  const bounds = mapChunkBounds(halfExtent);

  const rawCx0 = chunkCoordOf(cameraTargetCell.x - radius) - margin;
  const rawCx1 = chunkCoordOf(cameraTargetCell.x + radius) + margin;
  const rawCz0 = chunkCoordOf(cameraTargetCell.z - radius) - margin;
  const rawCz1 = chunkCoordOf(cameraTargetCell.z + radius) + margin;

  // 各端点を独立にマップのチャンク範囲へクランプする(範囲同士のintersectではない)。
  // 注視点がマップ外はるか遠くを向いていても、範囲が空にならず「マップの縁の
  // チャンク」に必ず収束するようにするため。
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  const cx0 = clamp(rawCx0, bounds.cx0, bounds.cx1) || 0;
  const cx1 = clamp(rawCx1, bounds.cx0, bounds.cx1) || 0;
  const cz0 = clamp(rawCz0, bounds.cz0, bounds.cz1) || 0;
  const cz1 = clamp(rawCz1, bounds.cz0, bounds.cz1) || 0;

  const chunks: ChunkCoord[] = [];
  if (cx0 > cx1 || cz0 > cz1) return chunks;
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      chunks.push({ cx, cz });
    }
  }
  return chunks;
}

/**
 * チャンク(cx,cz)が持つセルの矩形範囲([x0,x1]×[z0,z1]、両端含む)を、マップ範囲
 * (-halfExtent..halfExtent)へクランプして返す。クランプの結果セルが1つも残らない場合は
 * null(チャンク全体がマップ範囲外)。
 */
export function chunkCellBounds(
  chunk: ChunkCoord,
  halfExtent: number,
): { x0: number; x1: number; z0: number; z1: number } | null {
  const extent = Math.max(0, halfExtent);
  const rawX0 = chunk.cx * TERRAIN_CHUNK_SIZE;
  const rawX1 = rawX0 + TERRAIN_CHUNK_SIZE - 1;
  const rawZ0 = chunk.cz * TERRAIN_CHUNK_SIZE;
  const rawZ1 = rawZ0 + TERRAIN_CHUNK_SIZE - 1;

  const x0 = Math.max(-extent, rawX0);
  const x1 = Math.min(extent, rawX1);
  const z0 = Math.max(-extent, rawZ0);
  const z1 = Math.min(extent, rawZ1);

  if (x0 > x1 || z0 > z1) return null;
  return { x0, x1, z0, z1 };
}

/**
 * チャンク(cx,cz)に属する全セル(マップ範囲でクランプ済み)を列挙する。
 * x昇順→z昇順(TerrainBlocks/Sceneryの既存の全域スキャンと同じ走査順)。
 */
export function* chunkCells(chunk: ChunkCoord, halfExtent: number): Generator<CellPos> {
  const bounds = chunkCellBounds(chunk, halfExtent);
  if (!bounds) return;
  for (let x = bounds.x0; x <= bounds.x1; x++) {
    for (let z = bounds.z0; z <= bounds.z1; z++) {
      yield { x, z };
    }
  }
}
