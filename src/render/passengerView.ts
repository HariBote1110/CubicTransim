// D2: 乗客視点(乗車モード)のカメラ計算とライダー状態。
//
// D1の透視投影パス(webgpuLayer.ts / WebGpuTerrainLayer.tsx)の上に、
// 「選択中の列車に乗って車窓を眺める」モードを足す。カーブの再実装はしない
// (progress/play-modes-plan.md の「遠い将来の夢」メモどおり、sim/consist.ts の
// carPositions が列車描画のためにすでに持っている曲線サンプリング+進行方向を
// そのまま使う)。

import type { SimWorld } from '../sim/simulation';
import { carPositions } from '../sim/consist';

/** 目線の高さ(先頭車のrenderPos.y — すでにレール天面+0.5のベース込み — からの上乗せ)。 */
export const PASSENGER_EYE_HEIGHT = 1.6;
/** 注視点を進行方向へどれだけ先に置くか(ワールド単位)。カーブでのパンを滑らかにする。 */
export const PASSENGER_LOOK_AHEAD = 9;
/** 乗車中のメッシュチャンク可視半径(セル)。D1の地形メッシュ半径と揃える。 */
export const PASSENGER_CHUNK_VIEW_RADIUS_CELLS = 48;
/** 乗車中の地形メッシュ再構築しきい値(セル)。WebGpuBuildPreviewのGRID_SNAP_CELLSと同じ規約。 */
export const PASSENGER_TERRAIN_REBAKE_THRESHOLD_CELLS = 8;

export interface RiderCamera {
  eye: [number, number, number];
  look: [number, number, number];
}

/**
 * 選択中の列車の先頭車から乗客視点カメラ(視点+注視点)を求める。
 *
 * `carPositions(rt, 1, ...)` の先頭車出力(x/y/z + heading、いずれも曲線サンプリング済み)
 * をそのまま使うだけで、勾配・高架・地下のy(carPositions内部のtrackCentreHeight)も
 * 列車描画と完全に同じ式になる。補間は一切行わない(毎フレームその場の位置から
 * 組み立て直すだけ)ので、折り返し・車庫への瞬間移動でも前フレームの値を引きずらず
 * 素直にスナップする。
 */
export function computeRiderCamera(world: SimWorld, trainId: string): RiderCamera | null {
  const rt = world.runtimes.get(trainId);
  if (!rt) return null;
  const [head] = carPositions(rt, 1, 1.0, world.railMap, world.terrainField);
  if (!head) return null;
  const eye: [number, number, number] = [head.x, head.y + PASSENGER_EYE_HEIGHT, head.z];
  const look: [number, number, number] = [
    eye[0] + head.heading.x * PASSENGER_LOOK_AHEAD,
    eye[1] + head.heading.y * PASSENGER_LOOK_AHEAD,
    eye[2] + head.heading.z * PASSENGER_LOOK_AHEAD,
  ];
  return { eye, look };
}

/**
 * 乗車状態(モジュール単位のミュータブルフラグ)。D1の `perspectiveDebugState` と
 * 同じ設計判断: フレームループのコールバック(WebGpuTerrainLayer.tsx の
 * WebGpuRenderDriver、GameScene.tsx のチャンク可視範囲計算)が毎フレーム直接読む
 * ため、Reactの再レンダリングを経由しない。UIの表示切替(乗車/降車ボタン・
 * ポインタブロッカー)は別途Reactステート(App.tsxのridingTrainId)を鏡写しに持つ。
 */
export const riderState: { trainId: string | null } = { trainId: null };
