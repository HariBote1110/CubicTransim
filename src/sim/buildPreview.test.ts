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
  TERRAIN_EDIT_COST,
} from './economy';
import { applyElevatedPath } from './construction';
import type { TerrainField } from './terrainField';
import { fieldFromMaps } from './terrainField';
import type { EditBlockers } from './terrainOverlay';
import { createEditedTerrainField } from './terrainOverlay';

const emptyMaps = () => {
  const terrain = new Map<string, TerrainType>();
  const heights = new Map<string, number>();
  return {
    railMap: new Map<string, CellData>(),
    stations: new Map<string, StationData>(),
    terrain,
    heights,
    field: fieldFromMaps(heights, terrain, 45),
  };
};

// evaluateBuild('raise'/'lower', ...)向けのterrainEdit引数を組み立てる。
// blockersはuseGameLogic.commitPathと同じ規則(範囲外・線路・町タイル・水域)。
const terrainEditFor = (
  field: TerrainField,
  railMap: Map<string, CellData>,
  townTiles: Map<string, unknown> = new Map()
) => {
  const editedField = createEditedTerrainField(field);
  const blockers: EditBlockers = {
    isCellBlocked: (x, z) =>
      x < -45 || x > 45 || z < -45 || z > 45 ||
      railMap.has(toKey(x, z)) ||
      townTiles.has(toKey(x, z)) ||
      field.terrainTypeAt(x, z) === 'water',
  };
  return { base: field, editedField, blockers };
};

describe('evaluateBuild', () => {
  it('平地の線路はセル数×RAIL_COST', () => {
    const { railMap, stations, field } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000);
    expect(p.cost).toBe(3 * RAIL_COST);
    expect(p.cellCount).toBe(3);
    expect(p.reason).toBe('ok');
    expect(p.bridgeCells).toBe(0);
    expect(p.tunnelCells).toBe(0);
  });

  it('水域は橋、山岳はトンネルとして割増コストと内訳を返す', () => {
    const { railMap, stations, terrain, field } = emptyMaps();
    terrain.set(toKey(1, 0), 'water');
    terrain.set(toKey(2, 0), 'mountain');
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000);
    expect(p.bridgeCells).toBe(1);
    expect(p.tunnelCells).toBe(1);
    expect(p.cost).toBe(RAIL_COST * (1 + BRIDGE_COST_MULTIPLIER + TUNNEL_COST_MULTIPLIER));
  });

  it('斜面フリンジ(天井が覆われていない山岳セル)を経路が横切る場合はno-effect', () => {
    const { railMap, stations, terrain, field } = emptyMaps();
    // 幅1セルの尾根(x軸方向、z=0)。南北が非mountainなので、尾根に沿って横切る
    // 経路の中間セルは坑口にも内部セルにもなれない。
    for (let x = -2; x <= 2; x++) terrain.set(toKey(x, 0), 'mountain');
    const path = [{ x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000);
    expect(p.reason).toBe('no-effect');
  });

  it('資金が足りなければ insufficient-funds', () => {
    const { railMap, stations, field } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, RAIL_COST);
    expect(p.reason).toBe('insufficient-funds');
    expect(p.cost).toBe(2 * RAIL_COST);
  });

  it('水域には駅を建てられない(no-effect)', () => {
    const { railMap, stations, terrain, field } = emptyMaps();
    terrain.set(toKey(0, 0), 'water');
    const p = evaluateBuild('station', [{ x: 0, z: 0 }], railMap, stations, field, 100_000);
    expect(p.reason).toBe('no-effect');
  });

  it('既に駅があるセルには重ねられない(no-effect)', () => {
    const { railMap, stations, field } = emptyMaps();
    railMap.set(toKey(0, 0), { type: 'station', connections: DIR.E | DIR.W, stationId: 'st1' });
    const p = evaluateBuild('station', [{ x: 0, z: 0 }], railMap, stations, field, 100_000);
    expect(p.reason).toBe('no-effect');
  });

  it('線路の上なら駅を建てられ、コストはSTATION_COST', () => {
    const { railMap, stations, field } = emptyMaps();
    railMap.set(toKey(0, 0), { type: 'rail', connections: 0 });
    const p = evaluateBuild('station', [{ x: 0, z: 0 }], railMap, stations, field, 100_000);
    expect(p.reason).toBe('ok');
    expect(p.cost).toBe(STATION_COST);
    expect(p.cellCount).toBe(1);
  });

  it('撤去は無料で、何も無い場所なら no-effect', () => {
    const { railMap, stations, field } = emptyMaps();
    const p = evaluateBuild('remove', [{ x: 3, z: 3 }], railMap, stations, field, 0);
    expect(p.cost).toBe(0);
    expect(p.reason).toBe('no-effect');
  });

  it('撤去対象があれば ok(資金0でも可)', () => {
    const { railMap, stations, field } = emptyMaps();
    railMap.set(toKey(3, 3), { type: 'rail', connections: 0 });
    const p = evaluateBuild('remove', [{ x: 3, z: 3 }], railMap, stations, field, 0);
    expect(p.reason).toBe('ok');
  });

  it('空パスは何も返さない', () => {
    const { railMap, stations, field } = emptyMaps();
    const p = evaluateBuild('rail', [], railMap, stations, field, 100_000);
    expect(p.cellCount).toBe(0);
    expect(p.cost).toBe(0);
  });

  it('直交する線路は平面交差(ダイヤモンドクロッシング)になり、倍率は掛からない', () => {
    const { railMap, stations, field } = emptyMaps();
    railMap.set(toKey(1, 1), { type: 'rail', connections: DIR.E | DIR.W });
    const path = [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 2 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000);
    expect(p.reason).toBe('ok');
    expect(p.cost).toBe(RAIL_COST * 3);
    expect(p.overpassCells).toBe(0);
  });

  it('level:0を明示しても、省略時(地平)と完全に同一の結果になる(回帰防止)', () => {
    const { railMap, stations, field } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const omitted = evaluateBuild('rail', path, railMap, stations, field, 100_000);
    const explicit = evaluateBuild('rail', path, railMap, stations, field, 100_000, 0);
    expect(explicit).toEqual(omitted);

    const stationOmitted = evaluateBuild('station', [{ x: 0, z: 0 }], railMap, stations, field, 100_000);
    const stationExplicit = evaluateBuild('station', [{ x: 0, z: 0 }], railMap, stations, field, 100_000, 0);
    expect(stationExplicit).toEqual(stationOmitted);
  });
});

describe('evaluateBuild(rail, level:0) 浮いた高架の端への自動接続', () => {
  it('端が浮いた高架(レベル1)の端タイルに接すると、坂セルはRAIL_COST・残りは通常コストになる', () => {
    let { railMap, stations, field } = emptyMaps();
    ({ railMap, stations } = applyElevatedPath(
      { railMap, stations },
      Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })),
      undefined, 1
    ));
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000, 0);
    expect(p.reason).toBe('ok');
    expect(p.rampCells).toBe(2);
    expect(p.cost).toBe(RAIL_COST * 3 + RAIL_COST * 2); // 平坦3セル + 坂2セル(いずれも等倍)
  });

  it('端に浮いた高架が無ければ、従来通りcellCount×RAIL_COSTのまま', () => {
    const { railMap, stations, field } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000, 0);
    expect(p.rampCells).toBe(0);
    expect(p.cost).toBe(3 * RAIL_COST);
  });
});

describe('evaluateBuild(rail, level>=1) 自由に敷ける高架線', () => {
  it('浮いた端(坂0)なら、全セルが橋桁(overpassCells)になる', () => {
    const { railMap, stations, field } = emptyMaps();
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
      { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000, 1);
    expect(p.reason).toBe('ok');
    expect(p.rampCells).toBe(0);
    expect(p.overpassCells).toBe(6);
    expect(p.cost).toBe(RAIL_COST * OVERPASS_COST_MULTIPLIER * 6);
  });

  it('地平の既存線路に接続すると、その端だけ坂+橋桁のコストと内訳を返す', () => {
    const { railMap, stations, field } = emptyMaps();
    railMap.set(toKey(-1, 0), { type: 'rail', connections: DIR.E });
    railMap.set(toKey(0, 0), { type: 'rail', connections: DIR.W });
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
      { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000, 1);
    expect(p.reason).toBe('ok');
    expect(p.rampCells).toBe(2);
    expect(p.overpassCells).toBe(4);
    expect(p.cost).toBe(RAIL_COST * 2 + RAIL_COST * OVERPASS_COST_MULTIPLIER * 4);
  });

  it('曲がる経路でも敷ける(直線という制約が無い)', () => {
    const { railMap, stations, field } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 1 }, { x: 2, z: 2 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000, 1);
    expect(p.reason).toBe('ok');
  });

  it('隣接しない経路指定はno-op', () => {
    const { railMap, stations, field } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 5, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000, 1);
    expect(p.reason).toBe('no-effect');
  });

  it('橋桁が駅セルの場合でも建設できる(高架は地平駅を跨げる)', () => {
    const { railMap, stations, field } = emptyMaps();
    railMap.set(toKey(2, 0), { type: 'station', connections: 0, stationId: 'st1' });
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000, 1);
    expect(p.reason).toBe('ok');
  });

  it('資金が足りなければinsufficient-funds', () => {
    const { railMap, stations, field } = emptyMaps();
    railMap.set(toKey(-1, 0), { type: 'rail', connections: DIR.E });
    railMap.set(toKey(0, 0), { type: 'rail', connections: DIR.W });
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
      { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    const p = evaluateBuild('rail', path, railMap, stations, field, 1, 1);
    expect(p.reason).toBe('insufficient-funds');
  });

  it('既存の高架に継ぎ足す場合、その端は坂にならない(rampCellsが変わらない)', () => {
    let { railMap, stations, field } = emptyMaps();
    ({ railMap, stations } = applyElevatedPath(
      { railMap, stations },
      [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 }],
      undefined, 1
    ));
    const path = [{ x: 2, z: 0 }, { x: 2, z: -1 }, { x: 2, z: -2 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000, 1);
    expect(p.reason).toBe('ok');
    // (2,0)は既存の橋桁への継ぎ足しなので坂にならない。反対側(2,-2)も浮いた端のまま。
    expect(p.rampCells).toBe(0);
  });
});

describe('evaluateBuild(station, level>=1) 高架駅タイル1枚', () => {
  it('高架の線路がある場所ならELEVATED_STATION_COSTで建設できる', () => {
    let { railMap, stations, field } = emptyMaps();
    ({ railMap, stations } = applyElevatedPath(
      { railMap, stations },
      [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }],
      undefined, 1
    ));
    const p = evaluateBuild('station', [{ x: 2, z: 0 }], railMap, stations, field, 100_000, 1);
    expect(p.reason).toBe('ok');
    expect(p.cost).toBe(ELEVATED_STATION_COST);
    expect(p.cellCount).toBe(1);
  });

  it('高架の線路が無ければno-effect', () => {
    const { railMap, stations, field } = emptyMaps();
    const p = evaluateBuild('station', [{ x: 2, z: 0 }], railMap, stations, field, 100_000, 1);
    expect(p.reason).toBe('no-effect');
  });
});

describe('evaluateBuild: 地形編集(盛土/切土)', () => {
  it('terrainEdit引数を省略するとno-effect(cellCountはpath長のまま)', () => {
    const { railMap, stations, field } = emptyMaps();
    const p = evaluateBuild('raise', [{ x: 0, z: 0 }, { x: 1, z: 0 }], railMap, stations, field, 100_000);
    expect(p.reason).toBe('no-effect');
    expect(p.cellCount).toBe(2);
  });

  it('平地の盛土は変化コーナー数×TERRAIN_EDIT_COSTでok', () => {
    const { railMap, stations, field } = emptyMaps();
    const p = evaluateBuild(
      'raise', [{ x: 0, z: 0 }, { x: 1, z: 0 }], railMap, stations, field, 100_000, 0,
      new Map(), terrainEditFor(field, railMap)
    );
    expect(p.reason).toBe('ok');
    expect(p.cost).toBe(p.cellCount * TERRAIN_EDIT_COST);
    expect(p.cellCount).toBeGreaterThan(0);
  });

  it('伝播で動くコーナーもコスト・セル数に含まれる', () => {
    const terrain = new Map<string, TerrainType>([['0,0', 'mountain']]);
    const heights = new Map<string, number>([['0,0', 1]]);
    const field = fieldFromMaps(heights, terrain, 45);
    const railMap = new Map<string, CellData>();
    const stations = new Map<string, StationData>();
    // 高さ1→2の盛土はコーナー格子上で隣接コーナーも引き上げる。
    const p = evaluateBuild(
      'raise', [{ x: 0, z: 0 }], railMap, stations, field, 100_000, 0,
      new Map(), terrainEditFor(field, railMap)
    );
    expect(p.reason).toBe('ok');
    expect(p.cellCount).toBeGreaterThan(0);
    expect(p.cost).toBe(p.cellCount * TERRAIN_EDIT_COST);
  });

  it('線路のあるセルはno-effect、資金不足はinsufficient-funds', () => {
    const { railMap, stations, field } = emptyMaps();
    railMap.set('0,0', { type: 'rail', connections: 0 });
    const blocked = evaluateBuild(
      'raise', [{ x: 0, z: 0 }], railMap, stations, field, 100_000, 0,
      new Map(), terrainEditFor(field, railMap)
    );
    expect(blocked.reason).toBe('no-effect');

    const emptyRailMap = new Map<string, CellData>();
    const poor = evaluateBuild(
      'raise', [{ x: 5, z: 5 }], emptyRailMap, stations, field, 10, 0,
      new Map(), terrainEditFor(field, emptyRailMap)
    );
    expect(poor.reason).toBe('insufficient-funds');
  });

  it('高さ0の切土はno-effect', () => {
    const { railMap, stations, field } = emptyMaps();
    const p = evaluateBuild(
      'lower', [{ x: 0, z: 0 }], railMap, stations, field, 100_000, 0,
      new Map(), terrainEditFor(field, railMap)
    );
    expect(p.reason).toBe('no-effect');
  });
});
