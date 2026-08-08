// R4c: DOMラベルオーバーレイ(駅名・町名・列車ツールチップ)の純粋な位置計算。
//
// WebGPUモードでは drei <Html> を廃止し、projectToScreenPx で毎フレーム座標を出す
// 素の DOM オーバーレイ(components/LabelOverlay.tsx)に置き換える。この関数は
// 「ワールド座標 + カメラ状態」から「オーバーレイ用コンテナ内のCSSピクセル座標」を
// 求める部分だけを切り出した純粋関数(コンポーネント側はDOM操作に専念する)。

import { projectToScreenPx, type WebGpuCameraState } from './webgpuCamera';

export interface OverlayPosition {
  /** コンテナ(canvasと同じ矩形)左上を原点とするCSSピクセル座標。 */
  left: number;
  top: number;
  /** コンテナの矩形からどれだけ外れているか(はみ出し量、非表示判定に使う)。0以下なら画面内。 */
  offscreenMargin: number;
}

/**
 * ワールド座標をオーバーレイのCSSピクセル座標へ変換する。
 *
 * `camera` は WebGpuCameraSync が渡す物理ピクセル単位の状態(widthPx/heightPx/pixelsPerUnit は
 * three.js の zoom×DPR)なので、CSSピクセルへ戻すには dpr で割る。
 */
export const worldToOverlayPx = (
  world: { x: number; y: number; z: number },
  camera: WebGpuCameraState,
  dpr: number,
): OverlayPosition => {
  const { sx, sy } = projectToScreenPx(world, camera);
  const cssW = camera.widthPx / dpr;
  const cssH = camera.heightPx / dpr;
  const left = cssW / 2 + sx / dpr;
  const top = cssH / 2 + sy / dpr;
  const overLeft = -left;
  const overRight = left - cssW;
  const overTop = -top;
  const overBottom = top - cssH;
  const offscreenMargin = Math.max(overLeft, overRight, overTop, overBottom);
  return { left, top, offscreenMargin };
};

/** 画面外判定(marginPxぶんの余裕を持たせる。ラベルの見た目のサイズぶん先読みで隠す用途)。 */
export const isOnScreen = (position: OverlayPosition, marginPx = 80): boolean =>
  position.offscreenMargin <= marginPx;
