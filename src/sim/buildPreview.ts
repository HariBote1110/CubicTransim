// 建設プレビューの評価。「いくらかかるか」「そもそも建設できるか」を
// 実際の建設ロジック(construction.ts)に問い合わせて求める純粋関数。
//
// UI側で条件を書き写すと本体のルール(水域・山岳のno-op、上書き防止など)と
// ずれていくため、apply系が「変化が無ければ同じ参照を返す」性質を使って
// 実際に適用してみた結果から判定する。
import type { CellData, StationData, TerrainType } from '../types';
import type { ConstructionState } from './construction';
import { applyRailPath, applyStation, applyDepot, applySignal, removePath } from './construction';
import { costOfPath, type ConstructionMode } from './economy';
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
}

export function evaluateBuild(
  mode: BuildMode,
  path: { x: number; z: number }[],
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  terrain: Map<string, TerrainType>,
  money: number
): BuildPreview {
  const empty: BuildPreview = {
    mode, cellCount: 0, cost: 0, reason: 'no-effect', bridgeCells: 0, tunnelCells: 0,
  };
  if (path.length === 0) return empty;

  let bridgeCells = 0;
  let tunnelCells = 0;
  if (mode === 'rail') {
    for (const cell of path) {
      const t = terrainAt(terrain, cell.x, cell.z);
      if (t === 'water') bridgeCells++;
      else if (t === 'mountain') tunnelCells++;
    }
  }

  const cost = mode === 'remove'
    ? 0
    : costOfPath(
        mode,
        path.length,
        mode === 'rail' ? path : undefined,
        mode === 'rail' ? terrain : undefined,
        mode === 'rail' ? railMap : undefined
      );

  // 実際に適用してみて、変化が生じるか(=建設が成立するか)を確かめる。
  const state: ConstructionState = { railMap, stations };
  let result: ConstructionState;
  switch (mode) {
    case 'remove': result = removePath(state, path); break;
    case 'signal': result = applySignal(state, path, terrain); break;
    case 'station': result = applyStation(state, path[path.length - 1], terrain); break;
    case 'depot': result = applyDepot(state, path[path.length - 1], terrain); break;
    case 'rail': result = applyRailPath(state, path, terrain); break;
  }
  // removePath は常に新しい Map を返すため参照比較では判定できない。
  // 撤去は「対象セルに何かある」ことをもって成立とする。
  const effective = mode === 'remove'
    ? path.some(c => railMap.has(`${c.x},${c.z}`))
    : (result.railMap !== state.railMap || result.stations !== state.stations);

  const cellCount = mode === 'rail' || mode === 'remove' ? path.length : 1;

  let reason: BuildBlockReason = 'ok';
  if (!effective) reason = 'no-effect';
  else if (cost > money) reason = 'insufficient-funds';

  return { mode, cellCount, cost, reason, bridgeCells, tunnelCells };
}
