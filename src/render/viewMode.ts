// 地下ビュー(A列車/Simutrans方式のカットアウェイ無し切替)の可視性・明暗を決める
// 純関数群。GameScene/TrackNetwork/TerrainBlocks/TownBlocks/Scenery/DynamicTrainは
// これらの判定結果に従ってMATERIALS/DIMMED_MATERIALS(render/palette.ts)を切り替えるだけで、
// 個々のコンポーネントに条件を書き写さない(progress/underground-design.mdのP8bメモ参照)。
//
// level は 0=地平、正=高架(uppers[L])、負=地下(uppers[-L])。selectedLevel は建設レベル
// 選択(GameUIのbuildLevel)で、地下ビューが有効なとき「今どの深さを見ているか」を兼ねる。

import { MESH_LAYER_CLASS } from './webgpuLayer';

/** 選択中のレベルが地下(負)かどうか。これが地下ビューへ入る唯一の条件。 */
export function isUndergroundView(selectedLevel: number): boolean {
  return selectedLevel < 0;
}

/**
 * 地下コンテンツ(線路)の描画バケット。
 *
 * - 'bright' 地下ビューで選択中の深さ。通常輝度・不透明(layerClass=underground)
 * - 'dim'    地下ビューで選択中でない深さ。薄い半透明(layerClass=translucent)
 * - 'hidden' 地上ビュー。何も描かない
 *
 * 0.5.0-Alpha-4c〜Alpha-8dでは地上ビューの地下線を「ゴースト」(地形の上へ薄く
 * 重ねる透けた表示)として出していたが、ユーザーから「地上ビューの地下線ゴーストが
 * ごちゃごちゃして見づらい」との報告を受け、Alpha-8eで地上ビューの地下線は完全に
 * 非表示(hidden)にした。
 *
 * 駅の発見容易性(Alpha-4cの元々の動機: 地下にしかない駅が地上ビューで消えて見つから
 * ない)は、駅ホームだけの別経路(WebGpuStations.tsx、この関数を経由しない)で
 * ゴースト表示を維持することで引き続き担保する。この関数の呼び出し元は
 * railGeometry.ts(線路)だけなので、この変更は線路の可視性だけに影響する。
 */
export type UndergroundBucket = 'bright' | 'dim' | 'hidden';

export function undergroundBucketOf(
  level: number,
  undergroundView: boolean,
  selectedLevel: number,
): UndergroundBucket {
  if (!undergroundView) return 'hidden';
  return level === selectedLevel ? 'bright' : 'dim';
}

// P8b: 地下ビュー中の描画順序。three.jsの不透明/半透明キューの並び替えに任せず、
// 「地表(半透明・depthWrite無効)は必ず先に描き、選択中の地下(不透明)は必ず後に
// 描く」ことをrenderOrderで明示する。ballast/sleepers/rails等バケット間の相対順は
// 問題にならない(同じレイヤー内なので)。値そのものに意味は無く、SURFACE<UNDERGROUNDの
// 大小関係だけが効く。
export const SURFACE_RENDER_ORDER = 0;
export const UNDERGROUND_RENDER_ORDER = 10;

/**
 * レベルlevelのコンテンツを暗く(dimmed)描くべきか。
 * 通常表示では何も暗くしない。地下ビュー中は、選択中のレベル以外(地平・高架・
 * 選択していない別の地下レベル)をすべて暗くし、選択中のレベルだけ通常輝度にする。
 */
export function isLevelDimmed(level: number, undergroundView: boolean, selectedLevel: number): boolean {
  if (!undergroundView) return false;
  return level !== selectedLevel;
}

/**
 * 建設プレビュー(ゴースト表示)のメッシュ描画クラスを、セル群の最小y座標から選ぶ。
 * 地下(y<0)を含むプレビューは undergroundGhost(深度Always+αブレンド)で描かないと
 * 地形に隠れて見えなくなる(progress/参照)。地上のプレビューは従来通り translucent。
 */
export function previewMeshLayerClass(minY: number): number {
  return minY < 0 ? MESH_LAYER_CLASS.undergroundGhost : MESH_LAYER_CLASS.translucent;
}
