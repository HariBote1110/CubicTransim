// 経済システムの定数と建設コスト計算。
// 純粋関数のみ。React/THREE には依存しない。

export const STARTING_MONEY = 50_000;

export const RAIL_COST = 100; // 1セルあたり
export const STATION_COST = 1_000;
export const DEPOT_COST = 2_000;
export const SIGNAL_COST = 200;
export const TRAIN_COST = 5_000;

export const PASSENGER_SPAWN_RATE = 0.5; // 人/秒/駅
export const STATION_WAITING_CAP = 200;
export const TRAIN_CAPACITY = 100;
export const FARE_PER_TILE = 2;

export type ConstructionMode = 'rail' | 'station' | 'depot' | 'signal';

// path上に建設する際のコストを計算する。
// rail はセル数に比例、station/depot/signal は単セル操作なので単価固定。
export function costOfPath(mode: ConstructionMode, cellCount: number): number {
  switch (mode) {
    case 'rail':
      return cellCount * RAIL_COST;
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
