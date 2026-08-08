// R4c: WebGPUモードの列車クリック選択。
//
// R4bまでは three.js の DynamicTrain メッシュ自身が onClick を持っていたが、R4cで
// WebGPUモードの列車はインスタンス描画(WebGpuTrains.tsx)に置き換わり、three.js側の
// メッシュが存在しなくなる。GameSceneのピッキングはR4dでカメラごとwgpuへ移管するまで
// three.jsのまま(地面プレーンのonClick)なので、その中でこの純粋関数を使い、
// projectToScreenPxで先頭車のスクリーン位置へ投影して距離判定する(GPU往復なし)。

import { projectToScreenPx, type WebGpuCameraState } from './webgpuCamera';

export interface TrainScreenCandidate {
  trainId: string;
  /** 先頭車のワールド座標(carGroupPositionの結果でよい)。 */
  worldX: number;
  worldY: number;
  worldZ: number;
}

/** クリック判定半径(物理ピクセル)。列車の見た目の大きさに合わせた既定値。 */
export const TRAIN_PICK_RADIUS_PX = 22;

/**
 * カーソルのスクリーン座標(画面中心を原点とする物理ピクセル、projectToScreenPxと同じ空間)に
 * 最も近い列車を選ぶ。半径外は無視する。同点距離なら candidates の先着を優先する。
 */
export function pickTrainAtScreenPoint(
  candidates: readonly TrainScreenCandidate[],
  cursor: { sx: number; sy: number },
  camera: WebGpuCameraState,
  radiusPx: number = TRAIN_PICK_RADIUS_PX,
): string | null {
  let bestId: string | null = null;
  let bestDistSq = radiusPx * radiusPx;
  for (const c of candidates) {
    const { sx, sy } = projectToScreenPx({ x: c.worldX, y: c.worldY, z: c.worldZ }, camera);
    const dx = sx - cursor.sx;
    const dy = sy - cursor.sy;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestId = c.trainId;
    }
  }
  return bestId;
}
