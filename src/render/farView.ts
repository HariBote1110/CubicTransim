// 遠景(WebGPU全図ズームアウト)での three.js オーバーレイの扱いを決める純粋なポリシー。
// React/THREE には依存しない(GameScene.tsx / Scenery.tsx 側から呼ぶ)。
//
// 背景: R3(全図ズームアウト解禁)で WebGPU モードの minZoom を撤廃すると、
// TerrainBlocks 風の「可視チャンク列挙」(render/terrainChunks.ts の visibleChunkRange)を
// 素朴に呼ぶコンポーネント(Scenery=樹木、旧・町描画)が、可視半径(viewRadiusCells)が
// マップ全体に迫るにつれてチャンク数を二乗で膨張させ、配列生成そのものでヒッチする。
// (TerrainBlocksはWebGPUモードでは常にアンマウントされるため対象外)
//
// 方針は「実際に visibleChunkRange を呼ぶ前に、呼んだら何チャンクになるかを配列を
// 作らずに見積もり、予算を超えるなら列挙そのものをしない」。予算に対する近さ(比率)を
// 3段階(normal/dimmed/hidden)にマップし、dimmedは既存のDIMMED_MATERIALS機構
// (render/palette.tsのmaterialsFor(dimmed)、地下ビューで使っているのと同じ仕組み)を
// そのまま再利用する。連続的なopacity補間を実装しなくても「唐突に消えない」
// フェード感が出せる(design memo「keep it simple」)。

import { TERRAIN_CHUNK_SIZE } from './terrainChunks';

/**
 * 1パスで許容する可視チャンク数の上限。TerrainBlocks/Sceneryが同じ32x32セルの
 * チャンク単位を使う前提(およそ20x20チャンク=640セル四方相当)。
 */
export const FAR_VIEW_CHUNK_BUDGET = 400;

/**
 * レール・列車(chunk非依存、player-builtなので通常は小規模)にゆるく掛ける予算。
 * 遠景で railMap がこの件数を超えるような極端なケースの保険。
 */
export const FAR_VIEW_RAIL_CELL_BUDGET = 200_000;

/**
 * visibleChunkRange を実際に呼ばずに、呼んだ場合のチャンク数を見積もる(上限側の概算)。
 * マップ範囲によるクランプ(mapChunkBounds)は考慮しない分だけ実際の数以上になるが、
 * 「予算を超えるかどうか」の判定には十分で、かつ配列を一切割り当てないのでO(1)。
 */
export function estimateVisibleChunkCount(
  viewRadiusCells: number,
  margin = 1,
  chunkSize = TERRAIN_CHUNK_SIZE,
): number {
  const radiusChunks = Math.ceil(Math.max(0, viewRadiusCells) / chunkSize) + margin;
  const span = 2 * radiusChunks + 1;
  return span * span;
}

/** 予算に対する近さ(0=余裕、1=予算ちょうど、それ以上=超過)。 */
export function budgetRatio(count: number, budget: number): number {
  if (budget <= 0) return count > 0 ? Infinity : 0;
  return count / budget;
}

export type FarViewStage = 'normal' | 'dimmed' | 'hidden';

/** この比率からdimmed(既存のDIMMED_MATERIALSを流用)に切り替える。 */
export const FAR_VIEW_DIM_START_RATIO = 0.6;
/** この比率以上でhidden(列挙・描画そのものをしない)。 */
export const FAR_VIEW_HIDE_RATIO = 1.0;

/** budgetRatioの結果を3段階の表示方針へマップする。 */
export function farViewStageForRatio(ratio: number): FarViewStage {
  if (ratio >= FAR_VIEW_HIDE_RATIO) return 'hidden';
  if (ratio >= FAR_VIEW_DIM_START_RATIO) return 'dimmed';
  return 'normal';
}

/** viewRadiusCellsとチャンク予算から直接stageを求める便宜関数。 */
export function farViewStageForViewRadius(
  viewRadiusCells: number,
  budget = FAR_VIEW_CHUNK_BUDGET,
): FarViewStage {
  return farViewStageForRatio(budgetRatio(estimateVisibleChunkCount(viewRadiusCells), budget));
}
