import { describe, it, expect } from 'vitest';
import type { CellData, StationData, TrainData } from '../types';
import type { TrainRuntime } from './simulation';
import { serialiseWorld, deserialiseWorld } from './persistence';

describe('persistence: serialiseWorld / deserialiseWorld のラウンドトリップ', () => {
  it('railMap/stations/trains/runtimes が JSON 経由でも復元できる', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: 3 }],
      ['1,0', { type: 'station', connections: 15, stationId: 'stA' }],
    ]);
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'Station A', cells: [{ x: 1, z: 0 }], center: { x: 1, z: 0 } }],
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
      }],
    ]);

    const saveData = serialiseWorld(railMap, stations, trains, runtimes);
    const json = JSON.stringify(saveData);
    const parsed = JSON.parse(json);
    const restored = deserialiseWorld(parsed);

    expect(restored.railMap).toEqual(railMap);
    expect(restored.stations).toEqual(stations);
    expect(restored.trains).toEqual(trains);
    expect(restored.runtimes).toEqual(runtimes);
  });
});
