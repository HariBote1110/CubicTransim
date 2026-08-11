// R4d: 閉形式ピッキング。three.js の地面プレーン + レイキャストを退役させ、
// `projectToScreenPx` の逆関数だけでスクリーン座標→セルを求める(GPU往復なし、T13方針)。
//
// 等角投影(webgpuCamera.ts)は
//   sx = (rx - rz) * ppu * ISO_X
//   sy = (rx + rz) * ppu * ISO_Y - y * ppu * ISO_H
// なので、y を固定すれば rx/rz は一意に解ける。y を「見えている面の高さ」に取り替えながら
// 上から順に試すことで、丘の頂上をクリックしたときに手前の低いセルではなく、実際に
// 見えているセルを拾える(旧 TerrainBlocks の pickable 上面レイキャストと同じ結果)。

import { ISO_H, ISO_X, ISO_Y, type WebGpuCameraState } from './webgpuCamera';
import { OVERPASS_HEIGHT } from '../sim/trackPath';
import { TERRAIN_HEIGHT_MAX, type TerrainField } from '../sim/terrainField';

/** スクリーン座標(画面中心原点・物理ピクセル)を、高さ `yWorld` の水平面上の点へ落とす。 */
export const screenPxToGround = (
  camera: WebGpuCameraState,
  sx: number,
  sy: number,
  yWorld = 0,
): { x: number; z: number } => {
  const ppu = camera.pixelsPerUnit;
  if (!(ppu > 0)) return { x: camera.centreX, z: camera.centreZ };
  const a = sx / (ppu * ISO_X); // = rx - rz
  const b = (sy + yWorld * ppu * ISO_H) / (ppu * ISO_Y); // = rx + rz
  return { x: camera.centreX + (a + b) / 2, z: camera.centreZ + (b - a) / 2 };
};

export interface DomRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** DOM の clientX/clientY を、projectToScreenPx と同じ「画面中心原点の物理ピクセル」へ変換する。 */
export const clientToScreenPx = (
  clientX: number,
  clientY: number,
  rect: DomRectLike,
  dpr: number,
): { sx: number; sy: number } => ({
  sx: (clientX - rect.left - rect.width / 2) * dpr,
  sy: (clientY - rect.top - rect.height / 2) * dpr,
});

/** 地表(y=0)基準のセル。旧・地面プレーンの e.point を丸めていたのと同じ結果。 */
export const pickGroundCell = (
  camera: WebGpuCameraState,
  sx: number,
  sy: number,
): { x: number; z: number } => {
  const p = screenPxToGround(camera, sx, sy, 0);
  return { x: Math.round(p.x), z: Math.round(p.z) };
};

/**
 * 地形の高さを考慮したセル選択(地形編集モード用)。
 *
 * 高い候補から順に「その高さの水平面へ落としたセルの実際の標高が、その高さと一致するか」を
 * 調べ、最初に一致したセルを返す。丘の上面をクリックしたときに手前の低いセルではなく
 * 頂上のセルが選ばれる(旧 TerrainBlocks の上面メッシュへのレイキャストと同じ狙い)。
 * どの候補も一致しなければ地表(y=0)のセルへフォールバックする。
 */
export const pickTerrainCell = (
  camera: WebGpuCameraState,
  sx: number,
  sy: number,
  field: TerrainField,
  maxLevel: number = TERRAIN_HEIGHT_MAX,
): { x: number; z: number } => {
  for (let level = maxLevel; level >= 1; level--) {
    const p = screenPxToGround(camera, sx, sy, level * OVERPASS_HEIGHT);
    const cell = { x: Math.round(p.x), z: Math.round(p.z) };
    if (field.cellHeightAt(cell.x, cell.z) === level) return cell;
  }
  return pickGroundCell(camera, sx, sy);
};

export interface GroundBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** ビューポートの4隅を地表(y=0)へ落とした外接矩形。旧 CameraChunkTracker の逆投影の閉形式版。 */
export const visibleGroundBounds = (camera: WebGpuCameraState): GroundBounds => {
  const halfW = camera.widthPx / 2;
  const halfH = camera.heightPx / 2;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const sx of [-halfW, halfW]) {
    for (const sy of [-halfH, halfH]) {
      const p = screenPxToGround(camera, sx, sy, 0);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
  }
  return { minX, maxX, minZ, maxZ };
};

export interface ChunkView {
  targetCell: { x: number; z: number };
  viewRadiusCells: number;
}

/**
 * 可視チャンク追跡の入力(注視セル+可視半径)。旧 CameraChunkTracker と同じ意味の値を、
 * three.js の unproject 抜きで求める。`maxViewRadiusCells` を渡すとそこでクランプする
 * (マップ半径より広い可視半径を下流(render/farView.ts)へ流さないため。R3と同じ理由)。
 */
export const chunkViewFromCamera = (
  camera: WebGpuCameraState,
  maxViewRadiusCells?: number,
): ChunkView => {
  const b = visibleGroundBounds(camera);
  const raw = Math.max(0, Math.ceil(Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2));
  return {
    targetCell: { x: Math.round((b.minX + b.maxX) / 2), z: Math.round((b.minZ + b.maxZ) / 2) },
    viewRadiusCells: maxViewRadiusCells !== undefined ? Math.min(raw, maxViewRadiusCells) : raw,
  };
};
