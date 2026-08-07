// 地下ビュー(A列車/Simutrans方式のカットアウェイ無し切替)の可視性・明暗を決める
// 純関数群。GameScene/TrackNetwork/TerrainBlocks/TownBlocks/Scenery/DynamicTrainは
// これらの判定結果に従ってMATERIALS/DIMMED_MATERIALS(render/palette.ts)を切り替えるだけで、
// 個々のコンポーネントに条件を書き写さない(progress/underground-design.mdのP8bメモ参照)。
//
// level は 0=地平、正=高架(uppers[L])、負=地下(uppers[-L])。selectedLevel は建設レベル
// 選択(GameUIのbuildLevel)で、地下ビューが有効なとき「今どの深さを見ているか」を兼ねる。

/** 選択中のレベルが地下(負)かどうか。これが地下ビューへ入る唯一の条件。 */
export function isUndergroundView(selectedLevel: number): boolean {
  return selectedLevel < 0;
}

/**
 * レベルlevelのコンテンツをこのフレームで描画すべきか。
 * 地平・高架(level>=0)は常に描く。地下(level<0)は地下ビュー中だけ描く
 * (通常表示では掘割ランプの開口だけを別途描き、地下線そのものは隠す)。
 */
export function shouldRenderLevel(level: number, undergroundView: boolean): boolean {
  if (level < 0) return undergroundView;
  return true;
}

/**
 * レベルlevelのコンテンツを暗く(dimmed)描くべきか。
 * 通常表示では何も暗くしない。地下ビュー中は、選択中のレベル以外(地平・高架・
 * 選択していない別の地下レベル)をすべて暗くし、選択中のレベルだけ通常輝度にする。
 */
export function isLevelDimmed(level: number, undergroundView: boolean, selectedLevel: number): boolean {
  if (!undergroundView) return false;
  return level !== selectedLevel;
}
