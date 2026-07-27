import { describe, expect, it } from 'vitest';
import { DIR, toKey } from '../utils';
import type { CellData, StationData, TownData, TrainData } from '../types';
import type { SimWorld } from './simulation';
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
  OVERPASS_COST_MULTIPLIER,
  MAX_BRIDGE_LENGTH,
  PASSENGER_SPAWN_RATE,
  STATION_WAITING_CAP,
  FARE_PER_TILE,
  TOWN_INFLUENCE_RADIUS,
  PLATFORM_DOOR_STANDARD_COST,
  PLATFORM_DOOR_FULLSCREEN_COST,
  ACCIDENT_BASE_CHANCE,
  ACCIDENT_DOOR_MODIFIER,
  ACCIDENT_HALT_DURATION,
  ACCIDENT_PENALTY,
  SECONDS_PER_DAY,
  DAYS_PER_MONTH,
  clockToDate,
  RAIL_UPKEEP,
  STATION_UPKEEP,
  DEPOT_UPKEEP,
  UPKEEP_PER_CAR,
  CAPACITY_PER_CAR,
  CAR_COST,
  CAR_REFUND,
  calculateUpkeep,
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
    expect(CAPACITY_PER_CAR).toBe(50);
    expect(CAR_COST).toBe(2_000);
    expect(CAR_REFUND).toBe(1_000);
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
    id: 't1', name: '試験町', centre: { x: 0, z: 0 }, population: 1000, ...overrides,
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

  it('OVERPASS_COST_MULTIPLIERが仕様通り(4倍)', () => {
    expect(OVERPASS_COST_MULTIPLIER).toBe(4);
  });

  it('railMapを渡しても平面交差(自動高架は廃止)になるだけでOVERPASS_COST_MULTIPLIERはかからない', () => {
    const railMap = new Map<string, CellData>();
    // 東西の既存線路
    railMap.set(toKey(1, 1), { type: 'rail', connections: DIR.E | DIR.W });
    // 南北に交差させる新規path: (1,0)-(1,1)-(1,2)。平面交差になり倍率は掛からない。
    const path = [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 2 }];
    const terrain = new Map<string, 'water' | 'mountain'>();

    const cost = costOfPath('rail', path.length, path, terrain, railMap);
    expect(cost).toBe(RAIL_COST * 3);
  });
});

describe('economy: costOfPath(bridge)', () => {
  it('橋桁(坂を除いた中間セル)はOVERPASS_COST_MULTIPLIER倍、坂(両端2セルずつ)は通常のRAIL_COST', () => {
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
      { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    const cost = costOfPath('bridge', path.length, path);
    expect(cost).toBe(RAIL_COST * 4 + RAIL_COST * OVERPASS_COST_MULTIPLIER * 2);
  });

  it('MAX_BRIDGE_LENGTHが仕様通り(12)', () => {
    expect(MAX_BRIDGE_LENGTH).toBe(12);
  });
});

describe('economy: 定数(暦・維持費)', () => {
  it('暦・維持費の定数が仕様通り定義されている', () => {
    expect(SECONDS_PER_DAY).toBe(10);
    expect(DAYS_PER_MONTH).toBe(30);
    expect(UPKEEP_PER_CAR).toBe(250);
    expect(RAIL_UPKEEP).toBe(2);
    expect(STATION_UPKEEP).toBe(100);
    expect(DEPOT_UPKEEP).toBe(100);
  });
});

describe('economy: clockToDate', () => {
  it('0秒は1年1月1日', () => {
    expect(clockToDate(0)).toEqual({ year: 1, month: 1, day: 1 });
  });

  it('1日分未満(SECONDS_PER_DAY-1秒)は依然1年1月1日', () => {
    expect(clockToDate(SECONDS_PER_DAY - 1)).toEqual({ year: 1, month: 1, day: 1 });
  });

  it('1日経過すると1年1月2日になる', () => {
    expect(clockToDate(SECONDS_PER_DAY)).toEqual({ year: 1, month: 1, day: 2 });
  });

  it('1ヶ月(DAYS_PER_MONTH日)経過すると1年2月1日になる', () => {
    expect(clockToDate(SECONDS_PER_DAY * DAYS_PER_MONTH)).toEqual({ year: 1, month: 2, day: 1 });
  });

  it('300秒は1年2月1日', () => {
    expect(clockToDate(300)).toEqual({ year: 1, month: 2, day: 1 });
  });

  it('12ヶ月経過すると2年1月1日になる(年が繰り上がる)', () => {
    expect(clockToDate(SECONDS_PER_DAY * DAYS_PER_MONTH * 12)).toEqual({ year: 2, month: 1, day: 1 });
  });
});

describe('economy: calculateUpkeep', () => {
  it('列車2・線路10セル・駅2・車庫1の合計が定数通り', () => {
    const railMap = new Map<string, CellData>();
    for (let i = 0; i < 10; i++) {
      railMap.set(`rail-${i}`, { type: 'rail', connections: 3 });
    }
    railMap.set('depot-0', { type: 'depot', connections: 0 });

    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [], center: { x: 1, z: 1 }, platformDoors: 'none' }],
    ]);

    const trains: TrainData[] = [
      { id: 't1', x: 0, z: 0, schedule: [], scheduleIndex: 0, status: 'running', cars: 2 },
      { id: 't2', x: 0, z: 0, schedule: [], scheduleIndex: 0, status: 'running', cars: 4 },
    ];

    const world: SimWorld = {
      railMap, stations, trains, runtimes: new Map(), waiting: new Map(), rng: () => 1,
    };

    expect(calculateUpkeep(world)).toBe((2 + 4) * UPKEEP_PER_CAR + 10 * RAIL_UPKEEP + 2 * STATION_UPKEEP + 1 * DEPOT_UPKEEP);
    expect(calculateUpkeep(world)).toBe(1820);
  });
});
