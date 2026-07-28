// 建設プレビューの評価。「いくらかかるか」「そもそも建設できるか」を
// 実際の建設ロジック(construction.ts)に問い合わせて求める純粋関数。
//
// UI側で条件を書き写すと本体のルール(水域・山岳のno-op、上書き防止など)と
// ずれていくため、apply系が「変化が無ければ同じ参照を返す」性質を使って
// 実際に適用してみた結果から判定する。
//
// 高架ツール(旧'elevated'/'elevated-station')は廃止し、通常の'rail'/'station'が
// levelパラメータ(0=地平〜3)に従う形に統合した。level===0のときは従来の
// applyRailPath/applyStationと完全に同一の判定になる(回帰させないための最重要制約)。
import type { CellData, StationData, TerrainType } from '../types';
import type { ConstructionState, BuildLevel, ElevatedLevel } from './construction';
import {
  applyRailPathDetailed,
  applyStation,
  applyDepot,
  applySignal,
  applyElevatedPath,
  applyElevatedStation,
  removePath,
  resolveElevatedPathEnd,
  pickElevatedConnection,
  planElevatedPath,
} from './construction';
import { costOfPath, costOfElevatedPath, ELEVATED_STATION_COST, type ConstructionMode } from './economy';
import { terrainAt } from './terrain';

export type BuildMode = ConstructionMode | 'remove';

export type BuildBlockReason =
  | 'ok'
  /** 資金が足りない */
  | 'insufficient-funds'
  /** 地形や既存設備の制約で何も変化しない(水域に駅、既存セルの上書きなど) */
  | 'no-effect';

export interface BuildPreview {
  mode: BuildMode;
  /** 対象セル数(駅・車庫・信号は常に1) */
  cellCount: number;
  cost: number;
  reason: BuildBlockReason;
  /** 橋になるセル数(線路のみ) */
  bridgeCells: number;
  /** トンネルになるセル数(線路のみ) */
  tunnelCells: number;
  /** 立体交差(4倍コスト)になるセル数(線路のみ。高架線ではこれが橋桁=高架セル数) */
  overpassCells: number;
  /** 高架線(level>=1のrail)で坂になるセル数 */
  rampCells: number;
  /** 建設対象レベル(0=地平)。UI側が「高架(rail/station)かどうか」を判定するために保持する。 */
  level: BuildLevel;
}

export function evaluateBuild(
  mode: BuildMode,
  path: { x: number; z: number }[],
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  terrain: Map<string, TerrainType>,
  money: number,
  // 建設対象レベル。0=地平(従来のrail/station建設と完全に同一)、1〜3=高架。
  level: BuildLevel = 0
): BuildPreview {
  const empty: BuildPreview = {
    mode, cellCount: 0, cost: 0, reason: 'no-effect', bridgeCells: 0, tunnelCells: 0, overpassCells: 0, rampCells: 0, level,
  };
  if (path.length === 0) return empty;

  const elevated = level !== 0 && (mode === 'rail' || mode === 'station');
  const elevatedLevel = level as ElevatedLevel;

  let bridgeCells = 0;
  let tunnelCells = 0;
  if (mode === 'rail' && !elevated) {
    for (const cell of path) {
      const t = terrainAt(terrain, cell.x, cell.z);
      if (t === 'water') bridgeCells++;
      else if (t === 'mountain') tunnelCells++;
    }
  }

  // 高架のrail(level>=1)は、坂になるセル数・橋桁(高架)になるセル数の内訳を
  // construction.tsのresolveElevatedPathEnd/pickElevatedConnection/planElevatedPath
  // (建設ロジックそのもの)に問い合わせて求める(UI側にルールを書き写さないため)。
  let elevatedOverpassCount = 0;
  let elevatedRampCount = 0;
  if (mode === 'rail' && elevated && path.length >= 2) {
    const startEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, path[0]), elevatedLevel);
    const endEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, path[path.length - 1]), elevatedLevel);
    const plan = planElevatedPath(path.length, startEnd, endEnd, elevatedLevel);
    if (plan) {
      elevatedOverpassCount = plan.roles.filter(r => r.kind === 'span').length;
      elevatedRampCount = plan.roles.filter(r => r.kind === 'ramp').length;
    }
  }

  const cost = mode === 'remove'
    ? 0
    : mode === 'rail' && elevated
    ? costOfElevatedPath(elevatedRampCount, elevatedOverpassCount)
    : mode === 'station' && elevated
    ? ELEVATED_STATION_COST
    : costOfPath(
        mode === 'bridge' ? 'bridge' : mode,
        path.length,
        mode === 'rail' || mode === 'bridge' ? path : undefined,
        mode === 'rail' ? terrain : undefined,
        mode === 'rail' ? railMap : undefined
      );

  // 実際に適用してみて、変化が生じるか(=建設が成立するか)を確かめる。
  const state: ConstructionState = { railMap, stations };
  let result: ConstructionState;
  let overpassCells = 0;
  switch (mode) {
    case 'remove': result = removePath(state, path); break;
    case 'signal': result = applySignal(state, path, terrain); break;
    case 'station':
      result = elevated
        ? applyElevatedStation(state, path[path.length - 1], [], elevatedLevel)
        : applyStation(state, path[path.length - 1], terrain);
      break;
    case 'depot': result = applyDepot(state, path[path.length - 1], terrain); break;
    case 'rail': {
      if (elevated) {
        result = applyElevatedPath(state, path, terrain, elevatedLevel);
        if (result.railMap !== state.railMap) overpassCells = elevatedOverpassCount;
      } else {
        const detailed = applyRailPathDetailed(state, path, terrain);
        result = detailed;
        overpassCells = detailed.overpassCells.size;
      }
      break;
    }
    case 'bridge': {
      result = applyElevatedPath(state, path, terrain, 1);
      break;
    }
  }
  // removePath は常に新しい Map を返すため参照比較では判定できない。
  // 撤去は「対象セルに何かある」ことをもって成立とする。
  const effective = mode === 'remove'
    ? path.some(c => railMap.has(`${c.x},${c.z}`))
    : (result.railMap !== state.railMap || result.stations !== state.stations);

  const cellCount = mode === 'rail' || mode === 'remove' || mode === 'bridge' ? path.length : 1;

  let reason: BuildBlockReason = 'ok';
  if (!effective) reason = 'no-effect';
  else if (cost > money) reason = 'insufficient-funds';

  return { mode, cellCount, cost, reason, bridgeCells, tunnelCells, overpassCells, rampCells: elevatedRampCount, level };
}
