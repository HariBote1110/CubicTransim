import { describe, expect, it } from 'vitest';
import {
  costOfPath,
  STARTING_MONEY,
  RAIL_COST,
  STATION_COST,
  DEPOT_COST,
  SIGNAL_COST,
  TRAIN_COST,
  PASSENGER_SPAWN_RATE,
  STATION_WAITING_CAP,
  TRAIN_CAPACITY,
  FARE_PER_TILE,
} from './economy';

describe('economy: 定数', () => {
  it('初期所持金・単価が仕様通り定義されている', () => {
    expect(STARTING_MONEY).toBe(50_000);
    expect(RAIL_COST).toBe(100);
    expect(STATION_COST).toBe(1_000);
    expect(DEPOT_COST).toBe(2_000);
    expect(SIGNAL_COST).toBe(200);
    expect(TRAIN_COST).toBe(5_000);
    expect(PASSENGER_SPAWN_RATE).toBe(0.5);
    expect(STATION_WAITING_CAP).toBe(200);
    expect(TRAIN_CAPACITY).toBe(100);
    expect(FARE_PER_TILE).toBe(2);
  });
});

describe('economy: costOfPath', () => {
  it('rail はセル数×RAIL_COST', () => {
    expect(costOfPath('rail', 5)).toBe(5 * RAIL_COST);
    expect(costOfPath('rail', 0)).toBe(0);
  });

  it('station/depot/signal はセル数によらず単価固定', () => {
    expect(costOfPath('station', 1)).toBe(STATION_COST);
    expect(costOfPath('depot', 1)).toBe(DEPOT_COST);
    expect(costOfPath('signal', 1)).toBe(SIGNAL_COST);
    // cellCountが変でも固定単価（signal/stationは常に1セル操作のため）
    expect(costOfPath('station', 3)).toBe(STATION_COST);
  });
});
