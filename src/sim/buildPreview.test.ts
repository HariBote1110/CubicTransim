import { describe, expect, it } from 'vitest';
import { toKey } from '../utils';
import type { CellData, StationData, TerrainType } from '../types';
import { DIR } from '../utils';
import { evaluateBuild } from './buildPreview';
import { RAIL_COST, STATION_COST, BRIDGE_COST_MULTIPLIER, TUNNEL_COST_MULTIPLIER, OVERPASS_COST_MULTIPLIER } from './economy';

const emptyMaps = () => ({
  railMap: new Map<string, CellData>(),
  stations: new Map<string, StationData>(),
  terrain: new Map<string, TerrainType>(),
});

describe('evaluateBuild', () => {
  it('平地の線路はセル数×RAIL_COST', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, terrain, 100_000);
    expect(p.cost).toBe(3 * RAIL_COST);
    expect(p.cellCount).toBe(3);
    expect(p.reason).toBe('ok');
    expect(p.bridgeCells).toBe(0);
    expect(p.tunnelCells).toBe(0);
  });

  it('水域は橋、山岳はトンネルとして割増コストと内訳を返す', () => {
    const { railMap, stations, terrain } = emptyMaps();
    terrain.set(toKey(1, 0), 'water');
    terrain.set(toKey(2, 0), 'mountain');
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, terrain, 100_000);
    expect(p.bridgeCells).toBe(1);
    expect(p.tunnelCells).toBe(1);
    expect(p.cost).toBe(RAIL_COST * (1 + BRIDGE_COST_MULTIPLIER + TUNNEL_COST_MULTIPLIER));
  });

  it('資金が足りなければ insufficient-funds', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, terrain, RAIL_COST);
    expect(p.reason).toBe('insufficient-funds');
    expect(p.cost).toBe(2 * RAIL_COST);
  });

  it('水域には駅を建てられない(no-effect)', () => {
    const { railMap, stations, terrain } = emptyMaps();
    terrain.set(toKey(0, 0), 'water');
    const p = evaluateBuild('station', [{ x: 0, z: 0 }], railMap, stations, terrain, 100_000);
    expect(p.reason).toBe('no-effect');
  });

  it('既に駅があるセルには重ねられない(no-effect)', () => {
    const { railMap, stations, terrain } = emptyMaps();
    railMap.set(toKey(0, 0), { type: 'station', connections: 0, stationId: 'st1' });
    const p = evaluateBuild('station', [{ x: 0, z: 0 }], railMap, stations, terrain, 100_000);
    expect(p.reason).toBe('no-effect');
  });

  it('線路の上なら駅を建てられ、コストはSTATION_COST', () => {
    const { railMap, stations, terrain } = emptyMaps();
    railMap.set(toKey(0, 0), { type: 'rail', connections: 0 });
    const p = evaluateBuild('station', [{ x: 0, z: 0 }], railMap, stations, terrain, 100_000);
    expect(p.reason).toBe('ok');
    expect(p.cost).toBe(STATION_COST);
    expect(p.cellCount).toBe(1);
  });

  it('撤去は無料で、何も無い場所なら no-effect', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const p = evaluateBuild('remove', [{ x: 3, z: 3 }], railMap, stations, terrain, 0);
    expect(p.cost).toBe(0);
    expect(p.reason).toBe('no-effect');
  });

  it('撤去対象があれば ok(資金0でも可)', () => {
    const { railMap, stations, terrain } = emptyMaps();
    railMap.set(toKey(3, 3), { type: 'rail', connections: 0 });
    const p = evaluateBuild('remove', [{ x: 3, z: 3 }], railMap, stations, terrain, 0);
    expect(p.reason).toBe('ok');
  });

  it('空パスは何も返さない', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const p = evaluateBuild('rail', [], railMap, stations, terrain, 100_000);
    expect(p.cellCount).toBe(0);
    expect(p.cost).toBe(0);
  });

  it('立体交差になるセルはOVERPASS_COST_MULTIPLIER倍のコストになる', () => {
    const { railMap, stations, terrain } = emptyMaps();
    railMap.set(toKey(1, 1), { type: 'rail', connections: DIR.E | DIR.W });
    const path = [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 2 }];
    const p = evaluateBuild('rail', path, railMap, stations, terrain, 100_000);
    expect(p.reason).toBe('ok');
    expect(p.cost).toBe(RAIL_COST * 2 + RAIL_COST * OVERPASS_COST_MULTIPLIER);
  });
});
