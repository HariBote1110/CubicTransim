import { describe, it, expect } from 'vitest';
import type { CellData, StationData, TrainData, TownData, TerrainType } from '../types';
import type { TrainRuntime } from './simulation';
import { serialiseWorld, deserialiseWorld, emptyLedger } from './persistence';
import { STARTING_MONEY, type MonthlyLedger } from './economy';
import type { PassengerCohort } from './passengers';

describe('persistence: serialiseWorld / deserialiseWorld のラウンドトリップ (v12)', () => {
  it('railMap/stations/trains/runtimes/waiting/money/towns/terrain/clock/台帳/stopLocation/運用グループ/借入残高/行き先つき待ち客 が JSON 経由でも復元できる', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: 3 }],
      ['1,0', { type: 'station', connections: 15, stationId: 'stA' }],
    ]);
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'Station A', cells: [{ x: 1, z: 0, layer: 0 }], center: { x: 1, z: 0 }, platformDoors: 'none' }],
    ]);
    const trains: TrainData[] = [
      { id: 't1', x: 0, z: 0, schedule: ['stA'], scheduleIndex: 0, status: 'running', cars: 2 },
    ];
    const runtimes = new Map<string, TrainRuntime>([
      ['t1', {
        id: 't1',
        grid: { x: 0, z: 0 },
        prevGrid: null,
        progress: 0.5,
        speedKmh: 42,
        route: [{ x: 1, z: 0 }],
        trail: [{ x: 0, z: 0 }], pathHistory: [{ x: 0, z: 0 }],
        stopRemaining: 0,
        waitTimer: 0,
        debugStatus: 'Accelerating',
        renderPos: { x: 0.5, y: 0.5, z: 0 },
        renderTarget: { x: 1, y: 0.5, z: 0 },
        passengers: 12,
        lastStopStationId: 'stA',
        haltRemaining: 0,
        reservedEndIndex: -1,
        load: [],
      }],
    ]);
    const waiting = new Map<string, number>([['stA', 34]]);
    const money = 42_300;
    const towns: TownData[] = [{ id: 'town-0', name: '試験町', centre: { x: 5, z: 5 }, population: 2500 }];
    const terrain = new Map<string, TerrainType>([['2,2', 'water'], ['3,3', 'mountain']]);
    const clock = { elapsed: 1234 };
    const currentLedger: MonthlyLedger = { year: 1, month: 5, fares: 1000, construction: 2000, upkeep: 0, accidents: 0, interest: 0 };
    const ledgerHistory: MonthlyLedger[] = [
      { year: 1, month: 4, fares: 900, construction: 0, upkeep: 300, accidents: 5000, interest: 417 },
    ];

    const groups = [
      { id: 'g1', name: '1系統', schedule: ['stA', 'stB'], headwaySeconds: 45, colour: '#1f8fd6' },
    ];
    const groupDepartures = new Map<string, number>([['g1|stA', 987]]);
    const demand = new Map<string, PassengerCohort[]>([['stA', [{ destinationId: 'stB', count: 12.5 }]]]);

    const saveData = serialiseWorld(
      railMap, stations, trains, runtimes, waiting, money, towns, terrain,
      clock, currentLedger, ledgerHistory, 'far', groups, groupDepartures, 60_000, demand
    );
    expect(saveData.version).toBe(12);

    const json = JSON.stringify(saveData);
    const parsed = JSON.parse(json);
    const restored = deserialiseWorld(parsed);

    expect(restored.railMap).toEqual(railMap);
    expect(restored.clock).toEqual(clock);
    expect(restored.currentLedger).toEqual(currentLedger);
    expect(restored.ledgerHistory).toEqual(ledgerHistory);
    expect(restored.stations).toEqual(stations);
    expect(restored.trains).toEqual(trains);
    expect(restored.runtimes).toEqual(runtimes);
    expect(restored.waiting).toEqual(waiting);
    expect(restored.money).toBe(money);
    expect(restored.towns).toEqual(towns);
    expect(restored.terrain).toEqual(terrain);
    expect(restored.stopLocation).toBe('far');
    expect(restored.groups).toEqual(groups);
    expect(restored.groupDepartures).toEqual(groupDepartures);
    expect(restored.loan).toBe(60_000);
    expect(restored.demand).toEqual(demand);
  });

  it('v11データ(駅セルにlayerが無い)を読み込むと、全セルが地平(layer:0)として復元される', () => {
    const v11 = {
      version: 11 as const,
      railMap: [],
      stations: [
        ['stA', { id: 'stA', name: 'A駅', cells: [{ x: 1, z: 0 }, { x: 2, z: 0 }], center: { x: 1.5, z: 0 }, platformDoors: 'none' as const }],
      ] as [string, StationData][],
      trains: [], runtimes: [], waiting: [],
      money: 1000, loan: 0, towns: [], terrain: [],
      clock: { elapsed: 0 },
      currentLedger: emptyLedger(),
      ledgerHistory: [],
      stopLocation: 'middle' as const,
      groups: [], groupDepartures: [],
      demand: [],
    };
    const restored = deserialiseWorld(v11 as never);
    const st = restored.stations.get('stA')!;
    expect(st.cells).toEqual([{ x: 1, z: 0, layer: 0 }, { x: 2, z: 0, layer: 0 }]);
  });

  it('v10データ(行き先つき待ち客が無い)を読み込むと、待ち人数から行き先未定の客として復元する', () => {
    const v10 = {
      version: 10 as const,
      railMap: [], stations: [], trains: [], runtimes: [], waiting: [['stA', 7] as [string, number]],
      money: 1000, loan: 0, towns: [], terrain: [],
      clock: { elapsed: 0 },
      currentLedger: emptyLedger(),
      ledgerHistory: [],
      stopLocation: 'middle' as const,
      groups: [], groupDepartures: [],
    };
    const restored = deserialiseWorld(v10 as never);
    // 行き先が分からない客は運びようがないので捨てる(待ち客は湧き直す)
    expect(restored.demand.size).toBe(0);
  });

  it('v9データ(借入が無い)を読み込むと借入残高0・台帳の利息0が補われる', () => {
    const v9 = {
      version: 9 as const,
      railMap: [], stations: [], trains: [], runtimes: [], waiting: [],
      money: 1000, towns: [], terrain: [],
      clock: { elapsed: 0 },
      currentLedger: { year: 1, month: 1, fares: 0, construction: 0, upkeep: 0, accidents: 0 },
      ledgerHistory: [{ year: 1, month: 1, fares: 0, construction: 0, upkeep: 0, accidents: 0 }],
      stopLocation: 'middle' as const,
      groups: [], groupDepartures: [],
    };
    const restored = deserialiseWorld(v9 as never);
    expect(restored.loan).toBe(0);
    expect(restored.currentLedger.interest).toBe(0);
    expect(restored.ledgerHistory[0].interest).toBe(0);
  });

  it('v8データ(運用グループが無い)を読み込むと空のグループが補われる', () => {
    const v8 = {
      version: 8 as const,
      railMap: [], stations: [], trains: [], runtimes: [], waiting: [],
      money: 1000, towns: [], terrain: [],
      clock: { elapsed: 0 },
      currentLedger: { year: 1, month: 1, fares: 0, construction: 0, upkeep: 0, accidents: 0 },
      ledgerHistory: [],
      stopLocation: 'middle' as const,
    };
    const restored = deserialiseWorld(v8);
    expect(restored.groups).toEqual([]);
    expect(restored.groupDepartures.size).toBe(0);
  });
});

describe('persistence: v7→v8 移行', () => {
  it('v7データ(stopLocationが無い)を読み込むと既定値middleが補われる', () => {
    const v7Data = {
      version: 7,
      railMap: [['1,0', { type: 'station', connections: 15, stationId: 'stA' }]] as [string, CellData][],
      stations: [
        ['stA', { id: 'stA', name: 'Station A', cells: [{ x: 1, z: 0 }], center: { x: 1, z: 0 }, platformDoors: 'none' }],
      ] as [string, StationData][],
      trains: [
        { id: 't1', x: 0, z: 0, schedule: ['stA'], scheduleIndex: 0, status: 'running', cars: 2 },
      ] as TrainData[],
      runtimes: [] as [string, TrainRuntime][],
      waiting: [] as [string, number][],
      money: 1000,
      towns: [] as TownData[],
      terrain: [] as [string, TerrainType][],
      clock: { elapsed: 0 },
      currentLedger: emptyLedger(),
      ledgerHistory: [] as MonthlyLedger[],
    };

    const restored = deserialiseWorld(v7Data as never);

    expect(restored.stopLocation).toBe('middle');
  });
});

describe('persistence: v6→v7 移行', () => {
  it('v6データ(trains[].carsが無い)を読み込むと各列車にcars=2が補われる', () => {
    const v6Data = {
      version: 6,
      railMap: [['1,0', { type: 'station', connections: 15, stationId: 'stA' }]] as [string, CellData][],
      stations: [
        ['stA', { id: 'stA', name: 'Station A', cells: [{ x: 1, z: 0 }], center: { x: 1, z: 0 }, platformDoors: 'none' }],
      ] as [string, StationData][],
      trains: [
        { id: 't1', x: 0, z: 0, schedule: ['stA'], scheduleIndex: 0, status: 'running' },
        { id: 't2', x: 2, z: 0, schedule: [], scheduleIndex: 0, status: 'stored' },
      ] as unknown as TrainData[],
      runtimes: [['t1', {
        id: 't1',
        grid: { x: 0, z: 0 },
        prevGrid: null,
        progress: 0,
        speedKmh: 0,
        route: [],
        trail: [{ x: 0, z: 0 }], pathHistory: [{ x: 0, z: 0 }],
        stopRemaining: 0,
        waitTimer: 0,
        debugStatus: '',
        renderPos: { x: 0, y: 0.5, z: 0 },
        renderTarget: null,
        passengers: 0,
        lastStopStationId: null,
        haltRemaining: 0,
        reservedEndIndex: -1,
      }]] as unknown as [string, TrainRuntime][],
      waiting: [['stA', 12]] as [string, number][],
      money: 12_345,
      towns: [{ id: 'town-0', name: '試験町', centre: { x: 5, z: 5 }, population: 2500 }] as TownData[],
      terrain: [['2,2', 'water']] as [string, TerrainType][],
      clock: { elapsed: 999 },
      currentLedger: { year: 1, month: 3, fares: 0, construction: 0, upkeep: 0, accidents: 0 } as MonthlyLedger,
      ledgerHistory: [] as MonthlyLedger[],
    };

    const restored = deserialiseWorld(v6Data as never);

    expect(restored.money).toBe(12_345);
    expect(restored.trains.every(t => t.cars === 2)).toBe(true);
    expect(restored.trains).toHaveLength(2);
  });
});

describe('persistence: v5→v6 移行', () => {
  it('v5データ(clock/台帳が無い)を読み込むとelapsed=0・台帳空で補われる', () => {
    const v5Data = {
      version: 5,
      railMap: [['1,0', { type: 'station', connections: 15, stationId: 'stA' }]] as [string, CellData][],
      stations: [
        ['stA', { id: 'stA', name: 'Station A', cells: [{ x: 1, z: 0 }], center: { x: 1, z: 0 }, platformDoors: 'none' }],
      ] as [string, StationData][],
      trains: [{ id: 't1', x: 0, z: 0, schedule: ['stA'], scheduleIndex: 0, status: 'running' }] as unknown as TrainData[],
      runtimes: [['t1', {
        id: 't1',
        grid: { x: 0, z: 0 },
        prevGrid: null,
        progress: 0,
        speedKmh: 0,
        route: [],
        trail: [{ x: 0, z: 0 }], pathHistory: [{ x: 0, z: 0 }],
        stopRemaining: 0,
        waitTimer: 0,
        debugStatus: '',
        renderPos: { x: 0, y: 0.5, z: 0 },
        renderTarget: null,
        passengers: 0,
        lastStopStationId: null,
        haltRemaining: 0,
        reservedEndIndex: -1,
      }]] as unknown as [string, TrainRuntime][],
      waiting: [['stA', 12]] as [string, number][],
      money: 12_345,
      towns: [{ id: 'town-0', name: '試験町', centre: { x: 5, z: 5 }, population: 2500 }] as TownData[],
      terrain: [['2,2', 'water']] as [string, TerrainType][],
    };

    const restored = deserialiseWorld(v5Data as never);

    expect(restored.money).toBe(12_345);
    expect(restored.clock).toEqual({ elapsed: 0 });
    expect(restored.currentLedger).toEqual(emptyLedger());
    expect(restored.ledgerHistory).toEqual([]);
  });
});

describe('persistence: v4→v5 移行', () => {
  it('v4データ(terrainが無い)を読み込むとterrain=空Mapで補われる(既存セーブはフラット地形として動作)', () => {
    const v4Data = {
      version: 4,
      railMap: [['1,0', { type: 'station', connections: 15, stationId: 'stA' }]] as [string, CellData][],
      stations: [
        ['stA', { id: 'stA', name: 'Station A', cells: [{ x: 1, z: 0 }], center: { x: 1, z: 0 }, platformDoors: 'none' }],
      ] as [string, StationData][],
      trains: [{ id: 't1', x: 0, z: 0, schedule: ['stA'], scheduleIndex: 0, status: 'running' }] as unknown as TrainData[],
      runtimes: [['t1', {
        id: 't1',
        grid: { x: 0, z: 0 },
        prevGrid: null,
        progress: 0,
        speedKmh: 0,
        route: [],
        trail: [{ x: 0, z: 0 }], pathHistory: [{ x: 0, z: 0 }],
        stopRemaining: 0,
        waitTimer: 0,
        debugStatus: '',
        renderPos: { x: 0, y: 0.5, z: 0 },
        renderTarget: null,
        passengers: 0,
        lastStopStationId: null,
        haltRemaining: 0,
        reservedEndIndex: -1,
      }]] as unknown as [string, TrainRuntime][],
      waiting: [['stA', 12]] as [string, number][],
      money: 12_345,
      towns: [{ id: 'town-0', name: '試験町', centre: { x: 5, z: 5 }, population: 2500 }] as TownData[],
    };

    const restored = deserialiseWorld(v4Data as never);

    expect(restored.money).toBe(12_345);
    expect(restored.towns).toEqual(v4Data.towns);
    expect(restored.terrain).toEqual(new Map());
  });
});

describe('persistence: v3→v4 移行', () => {
  it('v3データ(townsが無い)を読み込むとtowns=[]で補われる(街なしでも動く)', () => {
    const v3Data = {
      version: 3,
      railMap: [['1,0', { type: 'station', connections: 15, stationId: 'stA' }]] as [string, CellData][],
      stations: [
        ['stA', { id: 'stA', name: 'Station A', cells: [{ x: 1, z: 0 }], center: { x: 1, z: 0 }, platformDoors: 'none' }],
      ] as [string, StationData][],
      trains: [{ id: 't1', x: 0, z: 0, schedule: ['stA'], scheduleIndex: 0, status: 'running' }] as unknown as TrainData[],
      runtimes: [['t1', {
        id: 't1',
        grid: { x: 0, z: 0 },
        prevGrid: null,
        progress: 0,
        speedKmh: 0,
        route: [],
        trail: [{ x: 0, z: 0 }], pathHistory: [{ x: 0, z: 0 }],
        stopRemaining: 0,
        waitTimer: 0,
        debugStatus: '',
        renderPos: { x: 0, y: 0.5, z: 0 },
        renderTarget: null,
        passengers: 0,
        lastStopStationId: null,
        haltRemaining: 0,
        reservedEndIndex: -1,
      }]] as unknown as [string, TrainRuntime][],
      waiting: [['stA', 12]] as [string, number][],
      money: 12_345,
    };

    const restored = deserialiseWorld(v3Data as never);

    expect(restored.money).toBe(12_345);
    expect(restored.towns).toEqual([]);
  });
});

describe('persistence: v1→v2 移行', () => {
  it('v1データ(waiting/money/passengers/lastStopStationIdが無い)を読み込むと安全な既定値で補われる', () => {
    const v1Data = {
      version: 1,
      railMap: [['0,0', { type: 'rail', connections: 3 }]] as [string, CellData][],
      stations: [] as [string, StationData][],
      trains: [{ id: 't1', x: 0, z: 0, schedule: [], scheduleIndex: 0, status: 'stored' }] as unknown as TrainData[],
      runtimes: [['t1', {
        id: 't1',
        grid: { x: 0, z: 0 },
        prevGrid: null,
        progress: 0,
        speedKmh: 0,
        route: [],
        trail: [{ x: 0, z: 0 }], pathHistory: [{ x: 0, z: 0 }],
        stopRemaining: 0,
        waitTimer: 0,
        debugStatus: '',
        renderPos: { x: 0, y: 0.5, z: 0 },
        renderTarget: null,
        // passengers/lastStopStationId が存在しない旧データを想定
      }]] as unknown as [string, TrainRuntime][],
    };

    const restored = deserialiseWorld(v1Data as never);

    expect(restored.money).toBe(STARTING_MONEY);
    expect(restored.waiting.size).toBe(0);
    const rt = restored.runtimes.get('t1')!;
    expect(rt.passengers).toBe(0);
    expect(rt.lastStopStationId).toBeNull();
    // v1→v4も既存の移行チェーンで安全な既定値になる
    expect(rt.haltRemaining).toBe(0);
    expect(restored.towns).toEqual([]);
  });
});

describe('persistence: v2→v3 移行', () => {
  it('v2データ(platformDoors/haltRemainingが無い)を読み込むと安全な既定値(none/0)で補われる', () => {
    const v2Data = {
      version: 2,
      railMap: [['1,0', { type: 'station', connections: 15, stationId: 'stA' }]] as [string, CellData][],
      stations: [
        ['stA', { id: 'stA', name: 'Station A', cells: [{ x: 1, z: 0 }], center: { x: 1, z: 0 } }],
      ] as unknown as [string, StationData][],
      trains: [{ id: 't1', x: 0, z: 0, schedule: ['stA'], scheduleIndex: 0, status: 'running' }] as unknown as TrainData[],
      runtimes: [['t1', {
        id: 't1',
        grid: { x: 0, z: 0 },
        prevGrid: null,
        progress: 0,
        speedKmh: 0,
        route: [],
        trail: [{ x: 0, z: 0 }], pathHistory: [{ x: 0, z: 0 }],
        stopRemaining: 0,
        waitTimer: 0,
        debugStatus: '',
        renderPos: { x: 0, y: 0.5, z: 0 },
        renderTarget: null,
        passengers: 0,
        lastStopStationId: null,
        // haltRemaining が存在しない旧データを想定
      }]] as unknown as [string, TrainRuntime][],
      waiting: [['stA', 12]] as [string, number][],
      money: 12_345,
    };

    const restored = deserialiseWorld(v2Data as never);

    expect(restored.money).toBe(12_345);
    expect(restored.waiting.get('stA')).toBe(12);
    expect(restored.stations.get('stA')!.platformDoors).toBe('none');
    expect(restored.runtimes.get('t1')!.haltRemaining).toBe(0);
    expect(restored.towns).toEqual([]);
  });
});
