import { describe, expect, it } from 'vitest';
import {
  costOfPath,
  calculateAccidentChance,
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
  PLATFORM_DOOR_STANDARD_COST,
  PLATFORM_DOOR_FULLSCREEN_COST,
  ACCIDENT_BASE_CHANCE,
  ACCIDENT_DOOR_MODIFIER,
  ACCIDENT_HALT_DURATION,
  ACCIDENT_PENALTY,
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
    expect(PLATFORM_DOOR_STANDARD_COST).toBe(3_000);
    expect(PLATFORM_DOOR_FULLSCREEN_COST).toBe(8_000);
    expect(ACCIDENT_BASE_CHANCE).toBe(0.01);
    expect(ACCIDENT_DOOR_MODIFIER.none).toBe(1.0);
    expect(ACCIDENT_DOOR_MODIFIER.standard).toBe(0.05);
    expect(ACCIDENT_DOOR_MODIFIER.fullscreen).toBe(0);
    expect(ACCIDENT_HALT_DURATION).toBe(60);
    expect(ACCIDENT_PENALTY).toBe(5_000);
  });
});

describe('economy: calculateAccidentChance', () => {
  it('none: waiting=0で基本確率の0.5倍、waiting=CAPで1.5倍になる(混雑係数の境界値)', () => {
    expect(calculateAccidentChance('none', 0)).toBeCloseTo(ACCIDENT_BASE_CHANCE * 0.5, 10);
    expect(calculateAccidentChance('none', STATION_WAITING_CAP)).toBeCloseTo(ACCIDENT_BASE_CHANCE * 1.5, 10);
  });

  it('standard: 確率がnoneの0.05倍になる', () => {
    const none = calculateAccidentChance('none', 100);
    const standard = calculateAccidentChance('standard', 100);
    expect(standard).toBeCloseTo(none * 0.05, 10);
  });

  it('fullscreen: waiting=0でも常に確率0', () => {
    expect(calculateAccidentChance('fullscreen', 0)).toBe(0);
    expect(calculateAccidentChance('fullscreen', STATION_WAITING_CAP)).toBe(0);
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
