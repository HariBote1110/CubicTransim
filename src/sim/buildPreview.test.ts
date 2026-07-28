import { describe, expect, it } from 'vitest';
import { toKey } from '../utils';
import type { CellData, StationData, TerrainType } from '../types';
import { DIR } from '../utils';
import { evaluateBuild, evaluateStationTemplate } from './buildPreview';
import { RAIL_COST, STATION_COST, BRIDGE_COST_MULTIPLIER, TUNNEL_COST_MULTIPLIER, OVERPASS_COST_MULTIPLIER } from './economy';
import { STATION_TEMPLATES } from './stationTemplates';
import { applyDepot } from './construction';

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
});

describe('evaluateBuild(bridge)', () => {
  it('坂+橋桁のコストと橋桁セル数を返す', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
      { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    const p = evaluateBuild('bridge', path, railMap, stations, terrain, 100_000);
    expect(p.reason).toBe('ok');
    expect(p.overpassCells).toBe(2);
    expect(p.cost).toBe(RAIL_COST * 4 + RAIL_COST * OVERPASS_COST_MULTIPLIER * 2);
  });

  it('直線でない指定はno-op', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 1 }];
    const p = evaluateBuild('bridge', path, railMap, stations, terrain, 100_000);
    expect(p.reason).toBe('no-effect');
  });

  it('橋桁が駅セルの場合はno-op', () => {
    const { railMap, stations, terrain } = emptyMaps();
    railMap.set(toKey(2, 0), { type: 'station', connections: 0, stationId: 'st1' });
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const p = evaluateBuild('bridge', path, railMap, stations, terrain, 100_000);
    expect(p.reason).toBe('no-effect');
  });

  it('資金が足りなければinsufficient-funds', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
      { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    const p = evaluateBuild('bridge', path, railMap, stations, terrain, 1);
    expect(p.reason).toBe('insufficient-funds');
  });
});

describe('evaluateStationTemplate', () => {
  const cross = STATION_TEMPLATES.find(t => t.id === 'cross')!;

  it('crossテンプレートは駅セル数(9)×STATION_COST', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const p = evaluateStationTemplate(cross, { x: 0, z: 0 }, 0, railMap, stations, terrain, 100_000);
    expect(p.reason).toBe('ok');
    expect(p.cellCount).toBe(9);
    expect(p.cost).toBe(9 * STATION_COST);
  });

  it('資金が足りなければinsufficient-funds', () => {
    const { railMap, stations, terrain } = emptyMaps();
    const p = evaluateStationTemplate(cross, { x: 0, z: 0 }, 0, railMap, stations, terrain, 1);
    expect(p.reason).toBe('insufficient-funds');
  });

  it('一部が車庫と重なる場合はno-effect', () => {
    let { railMap, stations, terrain } = emptyMaps();
    ({ railMap, stations } = applyDepot({ railMap, stations }, { x: 2, z: 0 }));
    const p = evaluateStationTemplate(cross, { x: 0, z: 0 }, 0, railMap, stations, terrain, 100_000);
    expect(p.reason).toBe('no-effect');
  });

  it('一部が水域の場合はno-effect', () => {
    const { railMap, stations, terrain } = emptyMaps();
    terrain.set(toKey(0, -2), 'water');
    const p = evaluateStationTemplate(cross, { x: 0, z: 0 }, 0, railMap, stations, terrain, 100_000);
    expect(p.reason).toBe('no-effect');
  });
});
