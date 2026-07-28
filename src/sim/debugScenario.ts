import type { CellData, StationData, TrainData } from '../types';
import { applyBridge, applyRailPath, applyStation, type ConstructionState } from './construction';
import { toKey } from '../utils';

export interface DebugScenario {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  trains: TrainData[];
}

/**
 * 起動時の目視確認用に、地平・坂・高架を往復する2編成を用意する。
 * セーブデータは使わず、その場で生成するため通常プレイの状態を汚さない。
 */
export function createDebugScenario(): DebugScenario {
  const path = Array.from({ length: 21 }, (_, i) => ({ x: i - 10, z: 0 }));
  let state: ConstructionState = { railMap: new Map(), stations: new Map() };
  state = applyRailPath(state, path);
  state = applyBridge(state, [
    { x: -3, z: 0 }, { x: -2, z: 0 }, { x: -1, z: 0 },
    { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 },
  ]);
  state = applyStation(state, { x: -9, z: 0 }, undefined, [], 'ew');
  state = applyStation(state, { x: 9, z: 0 }, undefined, [], 'ew');

  const westId = state.railMap.get(toKey(-9, 0))?.stationId;
  const eastId = state.railMap.get(toKey(9, 0))?.stationId;
  if (!westId || !eastId) throw new Error('デバッグシナリオの駅を作成できませんでした');

  return {
    railMap: state.railMap,
    stations: state.stations,
    trains: [
      // 駅セル中心に3両編成を置くと、初期履歴のない後続車が駅舎へ食い込む。
      // 駅外の直線へ置き、両編成とも余地を持って走り始める。
      { id: 'debug-west', x: -5, z: 0, schedule: [eastId, westId], scheduleIndex: 0, status: 'running', cars: 3 },
      { id: 'debug-east', x: 5, z: 0, schedule: [westId, eastId], scheduleIndex: 0, status: 'running', cars: 3 },
    ],
  };
}
