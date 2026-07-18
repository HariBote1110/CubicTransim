import { describe, it, expect } from 'vitest';
import type { CellData, StationData, TrainData } from '../types';
import type { TrainRuntime } from './simulation';
import { serialiseWorld, deserialiseWorld } from './persistence';
import { STARTING_MONEY } from './economy';

describe('persistence: serialiseWorld / deserialiseWorld のラウンドトリップ (v2)', () => {
  it('railMap/stations/trains/runtimes/waiting/money が JSON 経由でも復元できる', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: 3 }],
      ['1,0', { type: 'station', connections: 15, stationId: 'stA' }],
    ]);
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'Station A', cells: [{ x: 1, z: 0 }], center: { x: 1, z: 0 }, platformDoors: 'none' }],
    ]);
    const trains: TrainData[] = [
      { id: 't1', x: 0, z: 0, schedule: ['stA'], scheduleIndex: 0, status: 'running' },
    ];
    const runtimes = new Map<string, TrainRuntime>([
      ['t1', {
        id: 't1',
        grid: { x: 0, z: 0 },
        prevGrid: null,
        progress: 0.5,
        speedKmh: 42,
        route: [{ x: 1, z: 0 }],
        trail: [{ x: 0, z: 0 }],
        stopRemaining: 0,
        waitTimer: 0,
        debugStatus: 'Accelerating',
        renderPos: { x: 0.5, y: 0.5, z: 0 },
        renderTarget: { x: 1, y: 0.5, z: 0 },
        passengers: 12,
        lastStopStationId: 'stA',
      }],
    ]);
    const waiting = new Map<string, number>([['stA', 34]]);
    const money = 42_300;

    const saveData = serialiseWorld(railMap, stations, trains, runtimes, waiting, money);
    expect(saveData.version).toBe(2);

    const json = JSON.stringify(saveData);
    const parsed = JSON.parse(json);
    const restored = deserialiseWorld(parsed);

    expect(restored.railMap).toEqual(railMap);
    expect(restored.stations).toEqual(stations);
    expect(restored.trains).toEqual(trains);
    expect(restored.runtimes).toEqual(runtimes);
    expect(restored.waiting).toEqual(waiting);
    expect(restored.money).toBe(money);
  });
});

describe('persistence: v1→v2 移行', () => {
  it('v1データ(waiting/money/passengers/lastStopStationIdが無い)を読み込むと安全な既定値で補われる', () => {
    const v1Data = {
      version: 1,
      railMap: [['0,0', { type: 'rail', connections: 3 }]] as [string, CellData][],
      stations: [] as [string, StationData][],
      trains: [{ id: 't1', x: 0, z: 0, schedule: [], scheduleIndex: 0, status: 'stored' }] as TrainData[],
      runtimes: [['t1', {
        id: 't1',
        grid: { x: 0, z: 0 },
        prevGrid: null,
        progress: 0,
        speedKmh: 0,
        route: [],
        trail: [{ x: 0, z: 0 }],
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
  });
});
