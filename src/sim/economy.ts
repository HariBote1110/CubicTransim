// 経済システムの定数と建設コスト計算。
// 純粋関数のみ。React/THREE には依存しない。
import type { PlatformDoorType, TerrainType, TownData } from '../types';
import { terrainAt } from './terrain';

export const STARTING_MONEY = 50_000;

export const RAIL_COST = 100; // 1セルあたり(平地)
export const STATION_COST = 1_000;
export const DEPOT_COST = 2_000;
export const SIGNAL_COST = 200;
export const TRAIN_COST = 5_000;

// 水上は「橋」、山岳は「トンネル」としてRAIL_COSTに乗算する倍率
export const BRIDGE_COST_MULTIPLIER = 5;
export const TUNNEL_COST_MULTIPLIER = 8;

export const PASSENGER_SPAWN_RATE = 0.5; // 人/秒/駅(demandFactor=1のときの基準値)
export const STATION_WAITING_CAP = 200;
export const TRAIN_CAPACITY = 100;
export const FARE_PER_TILE = 2;

// 街の旅客需要が駅に及ぶ最大距離(タイル)。これを超えると影響0になる。
export const TOWN_INFLUENCE_RADIUS = 10;

// 駅の立地需要係数。周辺の街の人口と距離から算出する。
// 各街ごとに (population / 1000) × max(0, 1 - distance / TOWN_INFLUENCE_RADIUS) を合算する。
export function demandFactor(
  stationCentre: { x: number; z: number },
  towns: TownData[]
): number {
  let total = 0;
  for (const town of towns) {
    const dist = Math.hypot(stationCentre.x - town.centre.x, stationCentre.z - town.centre.z);
    const proximity = Math.max(0, 1 - dist / TOWN_INFLUENCE_RADIUS);
    total += (town.population / 1000) * proximity;
  }
  return total;
}

// ホームドア(駅単位・一括払い)
export const PLATFORM_DOOR_STANDARD_COST = 3_000;
export const PLATFORM_DOOR_FULLSCREEN_COST = 8_000;

// 人身事故: 停車1回あたりの発生確率とその影響
export const ACCIDENT_BASE_CHANCE = 0.01;
export const ACCIDENT_DOOR_MODIFIER = {
  none: 1.0,
  standard: 0.05,
  fullscreen: 0,
} as const;
export const ACCIDENT_HALT_DURATION = 60; // シミュレーション秒
export const ACCIDENT_PENALTY = 5_000;

export type ConstructionMode = 'rail' | 'station' | 'depot' | 'signal';

// 事故発生確率 = 基本確率 × ドア種別による係数 × 混雑係数(待ち0で0.5倍、満杯で1.5倍)
export function calculateAccidentChance(doorType: PlatformDoorType, waiting: number): number {
  const congestionFactor = 0.5 + waiting / STATION_WAITING_CAP;
  return ACCIDENT_BASE_CHANCE * ACCIDENT_DOOR_MODIFIER[doorType] * congestionFactor;
}

// path上に建設する際のコストを計算する。
// rail はセル数に比例、station/depot/signal は単セル操作なので単価固定。
// rail について path と terrain を渡すと、セルごとの地形(水域=橋/山岳=トンネル)を
// 反映した倍率込みの合計コストを返す。渡さない場合は従来通り平地扱いの単純計算。
export function costOfPath(
  mode: ConstructionMode,
  cellCount: number,
  path?: { x: number; z: number }[],
  terrain?: Map<string, TerrainType>
): number {
  switch (mode) {
    case 'rail': {
      if (path && terrain) {
        return path.reduce((sum, cell) => {
          const t = terrainAt(terrain, cell.x, cell.z);
          const multiplier =
            t === 'water' ? BRIDGE_COST_MULTIPLIER : t === 'mountain' ? TUNNEL_COST_MULTIPLIER : 1;
          return sum + RAIL_COST * multiplier;
        }, 0);
      }
      return cellCount * RAIL_COST;
    }
    case 'station':
      return STATION_COST;
    case 'depot':
      return DEPOT_COST;
    case 'signal':
      return SIGNAL_COST;
    default:
      return 0;
  }
}
