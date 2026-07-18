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
export type PlatformDoorType = keyof typeof ACCIDENT_DOOR_MODIFIER;

// 事故発生確率 = 基本確率 × ドア種別による係数 × 混雑係数(待ち0で0.5倍、満杯で1.5倍)
export function calculateAccidentChance(doorType: PlatformDoorType, waiting: number): number {
  const congestionFactor = 0.5 + waiting / STATION_WAITING_CAP;
  return ACCIDENT_BASE_CHANCE * ACCIDENT_DOOR_MODIFIER[doorType] * congestionFactor;
}

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
