import { describe, it, expect } from 'vitest';
import { DIR, toKey } from '../utils';
import type { CellData, StationData } from '../types';
import { calculateRoute } from './pathfinding';

// ブラウザで再現した「車庫から出発できない」シナリオの最小再現
describe('車庫→駅の経路探索(実機シナリオ再現)', () => {
  const railMap = new Map<string, CellData>();
  const stations = new Map<string, StationData>();

  // x = 0..10, z = 0 の直線。両端(0,0)=Station C, (10,0)=Station A
  for (let x = 1; x < 10; x++) {
    railMap.set(toKey(x, 0), { type: 'rail', connections: DIR.E | DIR.W });
  }
  railMap.set(toKey(0, 0), { type: 'station', connections: DIR.N | DIR.E | DIR.S | DIR.W, stationId: 'stC' });
  railMap.set(toKey(10, 0), { type: 'station', connections: DIR.N | DIR.E | DIR.S | DIR.W, stationId: 'stA' });
  // 車庫 (11,0)
  railMap.set(toKey(11, 0), { type: 'depot', connections: DIR.N | DIR.E | DIR.S | DIR.W, rotation: 0 });

  stations.set('stC', { id: 'stC', name: 'Station C', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 } });
  stations.set('stA', { id: 'stA', name: 'Station A', cells: [{ x: 10, z: 0 }], center: { x: 10, z: 0 } });

  it('車庫(11,0)から Station C(0,0) への経路が見つかる', () => {
    const path = calculateRoute(railMap, stations, new Set(), new Set(), {
      start: { x: 11, z: 0 },
      prev: null,
      targetStationId: 'stC',
    });
    expect(path.length).toBeGreaterThan(0);
  });
});

// ブラウザの実データを完全再現
describe('実機の盤面データ完全再現', () => {
  const railMap = new Map<string, CellData>();
  const stations = new Map<string, StationData>();

  railMap.set('-8,1', { type: 'station', connections: 170, stationId: 'lb4ktzf4f' });
  for (let x = -7; x <= 8; x++) {
    railMap.set(`${x},1`, { type: 'rail', connections: 34 });
  }
  railMap.set('9,1', { type: 'station', connections: 170, stationId: 'jrii129ep' });
  railMap.set('10,1', { type: 'rail', connections: 34 });
  railMap.set('11,1', { type: 'depot', connections: 170, rotation: 0 });

  stations.set('u1t0tds62', { id: 'u1t0tds62', name: 'Station A', cells: [{ x: 9, z: 1 }], center: { x: 9, z: 1 } });
  stations.set('jrii129ep', { id: 'jrii129ep', name: 'Station A', cells: [{ x: 9, z: 1 }], center: { x: 9, z: 1 } });
  stations.set('h9rvgp51x', { id: 'h9rvgp51x', name: 'Station C', cells: [{ x: -8, z: 1 }], center: { x: -8, z: 1 } });
  stations.set('lb4ktzf4f', { id: 'lb4ktzf4f', name: 'Station C', cells: [{ x: -8, z: 1 }], center: { x: -8, z: 1 } });

  it('車庫(11,1)から lb4ktzf4f への経路が見つかる', () => {
    const path = calculateRoute(railMap, stations, new Set(), new Set(), {
      start: { x: 11, z: 1 },
      prev: null,
      targetStationId: 'lb4ktzf4f',
    });
    expect(path.length).toBeGreaterThan(0);
  });
});
