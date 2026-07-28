import { describe, expect, it } from 'vitest';
import { toKey } from '../utils';
import type { CellData, StationData, TerrainType } from '../types';
import { DIR } from '../utils';
import { evaluateBuild } from './buildPreview';
import {
  RAIL_COST,
  STATION_COST,
  BRIDGE_COST_MULTIPLIER,
  TUNNEL_COST_MULTIPLIER,
  OVERPASS_COST_MULTIPLIER,
  ELEVATED_STATION_COST,
} from './economy';
import { applyElevatedPath } from './construction';

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
    railMap.set(toKey(0, 0), { type: 'station', connections: DIR.E | DIR.W, stationId: 'st1' });
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

  it('直交する線路は平面交差(ダイヤモンドクロッシング)になり、倍率は掛からない', () => {
    const { railMap, stations, terrain } = emptyMaps();
    railMap.set(toKey(1, 1), { type: 'rail', connections: DIR.E | DIR.W });
    const path = [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 2 }];
    const p = evaluateBuild('rail', path, railMap, stations, terrain, 100_000);
    expect(p.reason).toBe('ok');
    expect(p.cost).toBe(RAIL_COST * 3);
    expect(p.overpassCells).toBe(0);
  });

  it('level:0を明示しても、省略時(地平)と完全に同一の結果になる(回帰防止)', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const omitted = evaluateBuild('rail', path, railMap, stations, terrain, 100_000);
    const explicit = evaluateBuild('rail', path, railMap, stations, terrain, 100_000, 0);
    expect(explicit).toEqual(omitted);

    const stationOmitted = evaluateBuild('station', [{ x: 0, z: 0 }], railMap, stations, terrain, 100_000);
    const stationExplicit = evaluateBuild('station', [{ x: 0, z: 0 }], railMap, stations, terrain, 100_000, 0);
    expect(stationExplicit).toEqual(stationOmitted);
  });
});

describe('evaluateBuild(rail, level>=1) 自由に敷ける高架線', () => {
  it('浮いた端(坂0)なら、全セルが橋桁(overpassCells)になる', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
      { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    const p = evaluateBuild('rail', path, railMap, stations, terrain, 100_000, 1);
    expect(p.reason).toBe('ok');
    expect(p.rampCells).toBe(0);
    expect(p.overpassCells).toBe(6);
    expect(p.cost).toBe(RAIL_COST * OVERPASS_COST_MULTIPLIER * 6);
  });

  it('地平の既存線路に接続すると、その端だけ坂+橋桁のコストと内訳を返す', () => {
    const { railMap, stations, terrain } = emptyMaps();
    railMap.set(toKey(-1, 0), { type: 'rail', connections: DIR.E });
    railMap.set(toKey(0, 0), { type: 'rail', connections: DIR.W });
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
      { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    const p = evaluateBuild('rail', path, railMap, stations, terrain, 100_000, 1);
    expect(p.reason).toBe('ok');
    expect(p.rampCells).toBe(2);
    expect(p.overpassCells).toBe(4);
    expect(p.cost).toBe(RAIL_COST * 2 + RAIL_COST * OVERPASS_COST_MULTIPLIER * 4);
  });

  it('曲がる経路でも敷ける(直線という制約が無い)', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 1 }, { x: 2, z: 2 }];
    const p = evaluateBuild('rail', path, railMap, stations, terrain, 100_000, 1);
    expect(p.reason).toBe('ok');
  });

  it('隣接しない経路指定はno-op', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 5, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, terrain, 100_000, 1);
    expect(p.reason).toBe('no-effect');
  });

  it('橋桁が駅セルの場合でも建設できる(高架は地平駅を跨げる)', () => {
    const { railMap, stations, terrain } = emptyMaps();
    railMap.set(toKey(2, 0), { type: 'station', connections: 0, stationId: 'st1' });
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, terrain, 100_000, 1);
    expect(p.reason).toBe('ok');
  });

  it('資金が足りなければinsufficient-funds', () => {
    const { railMap, stations, terrain } = emptyMaps();
    railMap.set(toKey(-1, 0), { type: 'rail', connections: DIR.E });
    railMap.set(toKey(0, 0), { type: 'rail', connections: DIR.W });
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
      { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    const p = evaluateBuild('rail', path, railMap, stations, terrain, 1, 1);
    expect(p.reason).toBe('insufficient-funds');
  });

  it('既存の高架に継ぎ足す場合、その端は坂にならない(rampCellsが変わらない)', () => {
    let { railMap, stations } = emptyMaps();
    ({ railMap, stations } = applyElevatedPath(
      { railMap, stations },
      [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 }],
      undefined, 1
    ));
    const terrain = new Map<string, TerrainType>();
    const path = [{ x: 2, z: 0 }, { x: 2, z: -1 }, { x: 2, z: -2 }];
    const p = evaluateBuild('rail', path, railMap, stations, terrain, 100_000, 1);
    expect(p.reason).toBe('ok');
    // (2,0)は既存の橋桁への継ぎ足しなので坂にならない。反対側(2,-2)も浮いた端のまま。
    expect(p.rampCells).toBe(0);
  });
});

describe('evaluateBuild(station, level>=1) 高架駅タイル1枚', () => {
  it('高架の線路がある場所ならELEVATED_STATION_COSTで建設できる', () => {
    let { railMap, stations } = emptyMaps();
    ({ railMap, stations } = applyElevatedPath(
      { railMap, stations },
      [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }],
      undefined, 1
    ));
    const terrain = new Map<string, TerrainType>();
    const p = evaluateBuild('station', [{ x: 2, z: 0 }], railMap, stations, terrain, 100_000, 1);
    expect(p.reason).toBe('ok');
    expect(p.cost).toBe(ELEVATED_STATION_COST);
    expect(p.cellCount).toBe(1);
  });

  it('高架の線路が無ければno-effect', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const p = evaluateBuild('station', [{ x: 2, z: 0 }], railMap, stations, terrain, 100_000, 1);
    expect(p.reason).toBe('no-effect');
  });
});
