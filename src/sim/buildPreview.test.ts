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
  UNDERGROUND_RAIL_COST_MULTIPLIER,
  UNDERGROUND_STATION_COST,
  REGAUGE_COST_PER_CELL,
} from './economy';
import { applyElevatedPath, applyUndergroundPath, applyRailPath } from './construction';
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

  it('水域は橋、otherスロープはトンネルとして割増コストと内訳を返す', () => {
    const { railMap, stations } = emptyMaps();
    // P7bより、terrainTypeAt='mountain'なだけの平坦なセルはもうトンネルにならない
    // (mountain概念の廃止)。実際にトンネルが必要な地形(otherスロープ)を
    // TerrainFieldを直接実装するテストダブルで作る(x=2のみ4隅不揃い)。
    const field: TerrainField = {
      cornerHeightAt: () => 0,
      cellCornerHeights: (x) => (Math.round(x) === 2 ? [1, 1, 1, 0] : [0, 0, 0, 0]),
      cellHeightAt: () => 0,
      terrainTypeAt: (x) => (Math.round(x) === 1 ? 'water' : Math.round(x) === 2 ? 'mountain' : 'grass'),
    };
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000);
    expect(p.bridgeCells).toBe(1);
    expect(p.tunnelCells).toBe(1);
    expect(p.cost).toBe(RAIL_COST * (1 + BRIDGE_COST_MULTIPLIER + TUNNEL_COST_MULTIPLIER));
  });

  it('表示上mountain分類なだけで実際は平坦な尾根は、mountain概念の廃止によりno-effectにならず建設できる', () => {
    const { railMap, stations, terrain, field } = emptyMaps();
    // 幅1セルの尾根(x軸方向、z=0)。heightsを与えていないためコーナーは4隅とも
    // 標高0に潰れ、実際には完全に平坦(P7bではterrainTypeAtの分類自体は建設可否に
    // 影響しない)。
    for (let x = -2; x <= 2; x++) terrain.set(toKey(x, 0), 'mountain');
    const path = [{ x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000);
    expect(p.reason).toBe('ok');
    expect(p.tunnelCells).toBe(0);
  });

  it('P7d: 建設不可の地上レール経路は、UI向けにslopeIssueで具体的な理由を返す(other-slope)', () => {
    const { railMap, stations } = emptyMaps();
    // otherスロープ(0,0)の最大コーナー(1)が進入標高(2)より高くないため
    // トンネル化もできず建設不可(construction.test.tsの同種シナリオと同じ形)。
    const field: TerrainField = {
      cornerHeightAt: () => 0,
      cellCornerHeights: (x) => {
        const ix = Math.round(x);
        if (ix === -1) return [2, 2, 2, 2];
        if (ix === 0) return [2, 2, 1, 2];
        return [2, 2, 2, 2];
      },
      cellHeightAt: () => 0,
      terrainTypeAt: () => 'grass',
    };
    const path = [{ x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000);
    expect(p.reason).toBe('no-effect');
    expect(p.slopeIssue).toBe('other-slope');
  });

  it('P7d: トンネル出口の標高が食い違う経路はslopeIssue:tunnel-exit-mismatch', () => {
    const { railMap, stations } = emptyMaps();
    const field: TerrainField = {
      cornerHeightAt: () => 0,
      cellCornerHeights: (x) => {
        const ix = Math.round(x);
        if (ix === 0) return [2, 2, 2, 1];
        if (ix === 1) return [2, 1, 1, 2];
        if (ix === 2) return [1, 1, 1, 1];
        return [0, 0, 0, 0];
      },
      cellHeightAt: () => 0,
      terrainTypeAt: () => 'grass',
    };
    const path = [{ x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000);
    expect(p.reason).toBe('no-effect');
    expect(p.slopeIssue).toBe('tunnel-exit-mismatch');
  });

  it('P7d: 建設できる通常の経路にはslopeIssueが付かない', () => {
    const { railMap, stations, field } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000);
    expect(p.reason).toBe('ok');
    expect(p.slopeIssue).toBeUndefined();
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

describe('evaluateBuild(rail/station, level<0) 地下線・地下駅(P8a)', () => {
  it('地下線はRAIL_COST×UNDERGROUND_RAIL_COST_MULTIPLIER×セル数で建設できる', () => {
    const { railMap, stations, field } = emptyMaps();
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
    ];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000, -1);
    expect(p.reason).toBe('ok');
    expect(p.cost).toBe(RAIL_COST * UNDERGROUND_RAIL_COST_MULTIPLIER * 3);
  });

  it('水域を通る地下線はno-effect', () => {
    const { railMap, stations } = emptyMaps();
    const waterField = fieldFromMaps(new Map(), new Map<string, TerrainType>([[toKey(1, 0), 'water']]), 45);
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, waterField, 100_000, -1);
    expect(p.reason).toBe('no-effect');
  });

  it('地下駅はUNDERGROUND_STATION_COSTで建設できる', () => {
    let { railMap, stations, field } = emptyMaps();
    ({ railMap, stations } = applyUndergroundPath(
      { railMap, stations },
      [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }],
      field, -1
    ));
    const p = evaluateBuild('station', [{ x: 2, z: 0 }], railMap, stations, field, 100_000, -1);
    expect(p.reason).toBe('ok');
    expect(p.cost).toBe(UNDERGROUND_STATION_COST);
  });

  it('地下線が無ければ地下駅はno-effect', () => {
    const { railMap, stations, field } = emptyMaps();
    const p = evaluateBuild('station', [{ x: 2, z: 0 }], railMap, stations, field, 100_000, -1);
    expect(p.reason).toBe('no-effect');
  });
});

// 0.5.0-Alpha-4c: 高架/地下の線路は2マス以上の経路でしか敷けない(applyElevatedPath/
// applyUndergroundPathがpath.length<2をno-opにする)。ドラッグ前のホバー(1マス)を
// 「ここには建設できません」と判定してしまうと、実際には建設できる場所なのに
// 建設不可の表示が出続ける(ユーザー報告のバグ)。経路が短いだけの状態は
// 'incomplete-path'として区別する。
describe('evaluateBuild(rail, level!==0): 1マスの経路は incomplete-path', () => {
  it('地下の線路ツールでホバー中(1マス)はno-effectではなくincomplete-path', () => {
    const { railMap, stations, field } = emptyMaps();
    const p = evaluateBuild('rail', [{ x: 0, z: 0 }], railMap, stations, field, 100_000, -1);
    expect(p.reason).toBe('incomplete-path');
    expect(p.cost).toBe(0);
  });

  it('高架の線路ツールでホバー中(1マス)も同じくincomplete-path', () => {
    const { railMap, stations, field } = emptyMaps();
    const p = evaluateBuild('rail', [{ x: 0, z: 0 }], railMap, stations, field, 100_000, 2);
    expect(p.reason).toBe('incomplete-path');
    expect(p.cost).toBe(0);
  });

  it('地平(level 0)の線路は1マスでも建設できるのでokのまま', () => {
    const { railMap, stations, field } = emptyMaps();
    const p = evaluateBuild('rail', [{ x: 0, z: 0 }], railMap, stations, field, 100_000, 0);
    expect(p.reason).toBe('ok');
  });

  it('2マスあれば通常どおり判定する(地下)', () => {
    const { railMap, stations, field } = emptyMaps();
    const p = evaluateBuild('rail', [{ x: 0, z: 0 }, { x: 1, z: 0 }], railMap, stations, field, 100_000, -1);
    expect(p.reason).toBe('ok');
  });

  it('地下駅は1マスが正しい経路なのでincomplete-pathにはしない', () => {
    const { railMap, stations, field } = emptyMaps();
    const p = evaluateBuild('station', [{ x: 2, z: 0 }], railMap, stations, field, 100_000, -1);
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

describe('evaluateBuild: PM2 軌間・電化', () => {
  it('railOptions省略時は従来どおりの平地コスト(電化上乗せ無し)', () => {
    const { railMap, stations, field } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000, 0, new Map(), undefined, {});
    expect(p.cost).toBe(3 * RAIL_COST);
  });

  it('electrified:trueは架線設備費が上乗せされる', () => {
    const { railMap, stations, field } = emptyMaps();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const p = evaluateBuild('rail', path, railMap, stations, field, 100_000, 0, new Map(), undefined, { electrified: true });
    expect(p.cost).toBeGreaterThan(3 * RAIL_COST);
    expect(p.reason).toBe('ok');
  });

  it('軌間の異なる既存線路への接続は、経路自体は敷けるが接続ビットは立たない(construction.tsの規約をそのまま反映する)', () => {
    const { railMap: baseMap, stations, field } = emptyMaps();
    // 標準軌の単独セルを実際に敷いておく(construction.tsのapplyRailPathを直接使う)
    const laidState = applyRailPath({ railMap: baseMap, stations }, [{ x: -1, z: 0 }, { x: 0, z: 0 }], field, new Map(), { gauge: 1435 });
    const p = evaluateBuild('rail', [{ x: 0, z: 0 }, { x: 1, z: 0 }], laidState.railMap, laidState.stations, field, 100_000, 0, new Map(), undefined, { gauge: 1067 });
    // (1,0)は新規セルとして敷かれるため'ok'(no-effectにはならない)。
    // 実際に(0,0)⇔(1,0)間の接続ビットが立たないことはconstruction.test.tsで確認済み。
    expect(p.reason).toBe('ok');
  });
});

describe('evaluateBuild: PM2 Stage B 改軌', () => {
  it('regauge引数省略時はno-effect', () => {
    const { railMap, stations, field } = emptyMaps();
    const laid = applyRailPath({ railMap, stations }, [{ x: 0, z: 0 }, { x: 1, z: 0 }], field, new Map(), { gauge: 1067 });
    const p = evaluateBuild('regauge', [{ x: 0, z: 0 }, { x: 1, z: 0 }], laid.railMap, laid.stations, field, 100_000);
    expect(p.reason).toBe('no-effect');
  });

  it('狭軌→標準軌の改軌はcellCount×REGAUGE_COST_PER_CELLで見積もられる', () => {
    const { railMap, stations, field } = emptyMaps();
    const laid = applyRailPath({ railMap, stations }, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }], field, new Map(), { gauge: 1067 });
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const p = evaluateBuild('regauge', path, laid.railMap, laid.stations, field, 100_000, 0, new Map(), undefined, {}, { targetGauge: 1435 });
    expect(p.reason).toBe('ok');
    expect(p.cellCount).toBe(3);
    expect(p.cost).toBe(3 * REGAUGE_COST_PER_CELL);
  });

  it('既に目的軌間の区間はno-effect', () => {
    const { railMap, stations, field } = emptyMaps();
    const laid = applyRailPath({ railMap, stations }, [{ x: 0, z: 0 }, { x: 1, z: 0 }], field, new Map(), { gauge: 1435 });
    const p = evaluateBuild('regauge', [{ x: 0, z: 0 }, { x: 1, z: 0 }], laid.railMap, laid.stations, field, 100_000, 0, new Map(), undefined, {}, { targetGauge: 1435 });
    expect(p.reason).toBe('no-effect');
  });

  it('在線中のセルを含む区間はno-effect', () => {
    const { railMap, stations, field } = emptyMaps();
    const laid = applyRailPath({ railMap, stations }, [{ x: 0, z: 0 }, { x: 1, z: 0 }], field, new Map(), { gauge: 1067 });
    const occupiedCells = new Set([toKey(1, 0)]);
    const p = evaluateBuild('regauge', [{ x: 0, z: 0 }, { x: 1, z: 0 }], laid.railMap, laid.stations, field, 100_000, 0, new Map(), undefined, {}, { targetGauge: 1435, occupiedCells });
    expect(p.reason).toBe('no-effect');
  });

  it('資金不足ならinsufficient-funds', () => {
    const { railMap, stations, field } = emptyMaps();
    const laid = applyRailPath({ railMap, stations }, [{ x: 0, z: 0 }, { x: 1, z: 0 }], field, new Map(), { gauge: 1067 });
    const p = evaluateBuild('regauge', [{ x: 0, z: 0 }, { x: 1, z: 0 }], laid.railMap, laid.stations, field, 1, 0, new Map(), undefined, {}, { targetGauge: 1435 });
    expect(p.reason).toBe('insufficient-funds');
  });
});
