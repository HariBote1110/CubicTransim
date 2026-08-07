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
import type { CellData, StationData } from '../types';
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
  isElevatedConnectPlanBuildable,
  resolveGroundRailPlan,
  resolveGroundRailPlanDetailed,
  type GroundRailPlanFailureReason,
} from './construction';
import { costOfPath, costOfElevatedPath, costOfGroundPathWithRamps, costOfGroundRailPlan, costOfTerrainEdit, ELEVATED_STATION_COST, type ConstructionMode } from './economy';
import type { TerrainField } from './terrainField';
import type { EditedTerrainField } from './terrainOverlay';
import { applyCornerEdit, type EditBlockers } from './terrainOverlay';
import type { TownTileIndex } from './townTiles';

export type BuildMode = ConstructionMode | 'remove' | 'raise' | 'lower';

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
  /**
   * P7d: 地上レール(mode:'rail', level 0)がno-effectになった具体的な理由
   * (resolveGroundRailPlanDetailedの結果)。それ以外の建設不可(水域駅・既存セル上書きなど)
   * や建設可能な場合はundefined。GameUI.tsxがreason==='no-effect'時の表示文言を
   * より具体的にするために使う。
   */
  slopeIssue?: GroundRailPlanFailureReason;
}

export function evaluateBuild(
  mode: BuildMode,
  path: { x: number; z: number }[],
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  field: TerrainField,
  money: number,
  // 建設対象レベル。0=地平(従来のrail/station建設と完全に同一)、1〜3=高架。
  level: BuildLevel = 0,
  // 町タイル索引(sim/townTiles.tsのbuildTownTileIndex)。省略時は町タイル無し扱い。
  // apply系へそのまま渡し、家タイルを通る地平線路などが'no-effect'になるようにする。
  townTiles: TownTileIndex = new Map(),
  // 地形編集('raise'/'lower')の判定にのみ使う編集用引数。省略時は編集不可(no-effect)。
  terrainEdit?: {
    base: TerrainField;
    editedField: EditedTerrainField;
    blockers: EditBlockers;
  }
): BuildPreview {
  const empty: BuildPreview = {
    mode, cellCount: 0, cost: 0, reason: 'no-effect', bridgeCells: 0, tunnelCells: 0, overpassCells: 0, rampCells: 0, level,
  };
  if (path.length === 0) return empty;

  // 地形編集(盛土/切土)。実際の編集ロジック(terrainOverlay.tsのapplyCornerEdit)へ
  // そのまま問い合わせ、「変化が無ければ同一参照」の規約で可否を判定する。
  // cellCountとコストは、伝播で動くコーナー数を含む変化コーナー数(=課金対象)を使う。
  if (mode === 'raise' || mode === 'lower') {
    if (!terrainEdit) return { ...empty, cellCount: path.length };
    const a = path[0];
    const b = path[path.length - 1];
    const result = applyCornerEdit(terrainEdit.base, terrainEdit.editedField, { a, b }, mode, terrainEdit.blockers);
    const effective = result.field !== terrainEdit.editedField;
    const cost = costOfTerrainEdit(result.changedCorners);
    return {
      ...empty,
      cellCount: effective ? result.changedCorners : path.length,
      cost,
      reason: !effective ? 'no-effect' : cost > money ? 'insufficient-funds' : 'ok',
    };
  }

  const elevated = level !== 0 && (mode === 'rail' || mode === 'station');
  const elevatedLevel = level as ElevatedLevel;

  // P7b: bridgeCells/tunnelCellsはresolveGroundRailPlan(construction.ts、実際の建設
  // ロジックそのもの)に問い合わせる。tunnelはplanのtunnel役割セル数、bridgeは
  // (トンネルにならない)ground役割セルのうち水域のもの。planがnull(建設不可)なら
  // どちらも0のままにする(実際には建設されない=課金・表示上の内訳も意味が無いため)。
  let bridgeCells = 0;
  let tunnelCells = 0;
  let groundPlan: ReturnType<typeof resolveGroundRailPlan> = null;
  let groundSlopeIssue: GroundRailPlanFailureReason | undefined;
  if (mode === 'rail' && !elevated) {
    const detailed = resolveGroundRailPlanDetailed(field, path);
    groundPlan = detailed.plan;
    groundSlopeIssue = detailed.reason;
    if (groundPlan) {
      for (let i = 0; i < path.length; i++) {
        const role = groundPlan[i];
        if (role.kind === 'tunnel') tunnelCells++;
        else if (field.terrainTypeAt(path[i].x, path[i].z) === 'water') bridgeCells++;
      }
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

  // 地平(level 0)のrailも、端が浮いた高架の端タイルに接する場合は同様に
  // resolveElevatedPathEnd/pickElevatedConnection/planElevatedPathへ問い合わせ、
  // 自動で作られる坂の内訳(コスト計算・rampCells表示用)を求める。
  let groundRampFlags: boolean[] | null = null;
  if (mode === 'rail' && !elevated && path.length >= 2) {
    const startEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, path[0]), 0);
    const endEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, path[path.length - 1]), 0);
    if (startEnd.kind === 'connect' || endEnd.kind === 'connect') {
      const plan = planElevatedPath(path.length, startEnd, endEnd, 0);
      // 坂になるセルが車庫・水域・山岳で建設できない場合は、実際の建設(applyRailPath)側でも
      // 接続を諦めて平坦な地平線路にフォールバックするため、プレビューのコストも
      // 通常のcostOfPathへフォールバックする(groundRampFlagsをnullのままにする)。
      if (plan && isElevatedConnectPlanBuildable(railMap, path, field, plan)) {
        groundRampFlags = plan.roles.map(r => r.kind === 'ramp');
      }
    }
  }
  const groundRampCount = groundRampFlags ? groundRampFlags.filter(Boolean).length : 0;

  const cost = mode === 'remove'
    ? 0
    : mode === 'rail' && elevated
    ? costOfElevatedPath(elevatedRampCount, elevatedOverpassCount)
    : mode === 'rail' && groundRampFlags
    ? costOfGroundPathWithRamps(path, field, groundRampFlags)
    : mode === 'rail' && !elevated && groundPlan
    ? costOfGroundRailPlan(path, field, groundPlan)
    : mode === 'station' && elevated
    ? ELEVATED_STATION_COST
    : costOfPath(
        mode === 'bridge' ? 'bridge' : mode,
        path.length,
        mode === 'rail' || mode === 'bridge' ? path : undefined,
        mode === 'rail' ? field : undefined,
        mode === 'rail' ? railMap : undefined
      );

  // 実際に適用してみて、変化が生じるか(=建設が成立するか)を確かめる。
  const state: ConstructionState = { railMap, stations };
  let result: ConstructionState;
  let overpassCells = 0;
  switch (mode) {
    case 'remove': result = removePath(state, path); break;
    case 'signal': result = applySignal(state, path, field, townTiles); break;
    case 'station':
      result = elevated
        ? applyElevatedStation(state, path[path.length - 1], [], elevatedLevel)
        : applyStation(state, path[path.length - 1], field, [], undefined, townTiles);
      break;
    case 'depot': result = applyDepot(state, path[path.length - 1], field, townTiles); break;
    case 'rail': {
      if (elevated) {
        result = applyElevatedPath(state, path, field, elevatedLevel, undefined, townTiles);
        if (result.railMap !== state.railMap) overpassCells = elevatedOverpassCount;
      } else {
        const detailed = applyRailPathDetailed(state, path, field, townTiles);
        result = detailed;
        overpassCells = detailed.overpassCells.size;
      }
      break;
    }
    case 'bridge': {
      result = applyElevatedPath(state, path, field, 1, undefined, townTiles);
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

  const slopeIssue =
    mode === 'rail' && !elevated && !effective ? groundSlopeIssue : undefined;

  return {
    mode, cellCount, cost, reason, bridgeCells, tunnelCells, overpassCells,
    rampCells: elevatedRampCount || groundRampCount, level, slopeIssue,
  };
}
