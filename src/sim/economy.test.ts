import { describe, expect, it } from 'vitest';
import type { TownData } from '../types';
import {
  costOfPath,
  calculateAccidentChance,
  demandFactor,
  STARTING_MONEY,
  RAIL_COST,
  STATION_COST,
  DEPOT_COST,
  SIGNAL_COST,
  TRAIN_COST,
  BRIDGE_COST_MULTIPLIER,
  TUNNEL_COST_MULTIPLIER,
  PASSENGER_SPAWN_RATE,
  STATION_WAITING_CAP,
  TRAIN_CAPACITY,
  FARE_PER_TILE,
  TOWN_INFLUENCE_RADIUS,
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

describe('economy: demandFactor', () => {
  const town = (overrides: Partial<TownData>): TownData => ({
    id: 't1', centre: { x: 0, z: 0 }, population: 1000, ...overrides,
  });

  it('街の真上(distance=0)ではpopulation/1000になる', () => {
    const towns = [town({ centre: { x: 5, z: 5 }, population: 3000 })];
    expect(demandFactor({ x: 5, z: 5 }, towns)).toBeCloseTo(3, 10);
  });

  it('距離がTOWN_INFLUENCE_RADIUSちょうどでは0になる', () => {
    const towns = [town({ centre: { x: 0, z: 0 }, population: 2000 })];
    expect(demandFactor({ x: TOWN_INFLUENCE_RADIUS, z: 0 }, towns)).toBeCloseTo(0, 10);
  });

  it('影響半径を超えた街は寄与しない(負値にならない)', () => {
    const towns = [town({ centre: { x: 0, z: 0 }, population: 2000 })];
    expect(demandFactor({ x: TOWN_INFLUENCE_RADIUS + 5, z: 0 }, towns)).toBe(0);
  });

  it('複数の街の寄与は合算される', () => {
    const towns = [
      town({ id: 'a', centre: { x: 0, z: 0 }, population: 1000 }), // distance 0 → 1.0
      town({ id: 'b', centre: { x: 5, z: 0 }, population: 1000 }), // distance 5 → 0.5
    ];
    // stationCentre = (0,0): townA=1.0, townB: dist=5 → (1-5/10)=0.5 → 0.5
    expect(demandFactor({ x: 0, z: 0 }, towns)).toBeCloseTo(1.5, 10);
  });

  it('街が無ければ0になる', () => {
    expect(demandFactor({ x: 0, z: 0 }, [])).toBe(0);
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

  it('BRIDGE_COST_MULTIPLIER/TUNNEL_COST_MULTIPLIERが仕様通り', () => {
    expect(BRIDGE_COST_MULTIPLIER).toBe(5);
    expect(TUNNEL_COST_MULTIPLIER).toBe(8);
  });

  it('pathとterrainを渡すと地形ごとの倍率(水=橋5倍/山=トンネル8倍)を合算する', () => {
    const path = [
      { x: 0, z: 0 }, // 平地
      { x: 1, z: 0 }, // 平地
      { x: 2, z: 0 }, // 水
      { x: 3, z: 0 }, // 山
    ];
    const terrain = new Map<string, 'water' | 'mountain'>([
      ['2,0', 'water'],
      ['3,0', 'mountain'],
    ]);

    const cost = costOfPath('rail', path.length, path, terrain);
    expect(cost).toBe(RAIL_COST * 2 + RAIL_COST * BRIDGE_COST_MULTIPLIER + RAIL_COST * TUNNEL_COST_MULTIPLIER);
    expect(cost).toBe(100 * 2 + 500 + 800);
  });

  it('pathを渡さない場合は従来通りcellCount×RAIL_COSTのまま', () => {
    expect(costOfPath('rail', 5)).toBe(5 * RAIL_COST);
  });
});
