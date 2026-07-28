import { describe, expect, it } from 'vitest';
import { DIR, toKey } from '../utils';
import type { CellData, StationData, TerrainType, TownData } from '../types';
import {
  applyRailPath,
  applyRailPathDetailed,
  applyStation,
  applyDepot,
  applySignal,
  applyBridge,
  applyElevatedPath,
  applyElevatedStation,
  removePath,
  nextStationName,
  resolveElevatedPathEnd,
  planElevatedPath,
  pickElevatedConnection,
  planHasStraightRamps,
  type ConstructionState,
  type ElevatedEndPlan,
} from './construction';

const emptyState = (): ConstructionState => ({
  railMap: new Map<string, CellData>(),
  stations: new Map<string, StationData>(),
});

describe('applyRailPath（特性テスト）', () => {
  it('直線区間で双方向の connections が張られる', () => {
    const state = emptyState();
    const result = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }]);

    const a = result.railMap.get(toKey(0, 0))!;
    const b = result.railMap.get(toKey(1, 0))!;
    expect(a.type).toBe('rail');
    expect(a.connections! & DIR.E).toBe(DIR.E);
    expect(b.connections! & DIR.W).toBe(DIR.W);
  });

  it('元の state を変更しない（immutable）', () => {
    const state = emptyState();
    applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    expect(state.railMap.size).toBe(0);
  });
});

describe('applyStation（特性テスト）', () => {
  it('空セルに孤立して駅を設置すると新しい駅IDと東西(既定軸)の connections を持つ', () => {
    const state = emptyState();
    const result = applyStation(state, { x: 0, z: 0 });
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.type).toBe('station');
    expect(cell.connections).toBe(DIR.E | DIR.W);
    expect(result.stations.size).toBe(1);
  });

  it('axisを明示すると南北(ns)のconnectionsになる', () => {
    const state = emptyState();
    const result = applyStation(state, { x: 0, z: 0 }, undefined, [], 'ns');
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.connections).toBe(DIR.N | DIR.S);
  });

  it('隣接セルが南北にあれば軸をnsと推測する', () => {
    let state = emptyState();
    state = applyStation(state, { x: 0, z: -1 }, undefined, [], 'ns');
    state = applyStation(state, { x: 0, z: 0 }); // axis省略。北隣が駅なのでnsと推測されるはず
    const cell = state.railMap.get(toKey(0, 0))!;
    expect(cell.connections).toBe(DIR.N | DIR.S);
  });

  it('隣接する駅セルに設置すると同じ駅IDにマージされる', () => {
    let state = emptyState();
    state = applyStation(state, { x: 0, z: 0 });
    const firstId = Array.from(state.stations.keys())[0];
    state = applyStation(state, { x: 1, z: 0 });

    expect(state.stations.size).toBe(1);
    const st = state.stations.get(firstId)!;
    expect(st.cells).toHaveLength(2);
    expect(st.center).toEqual({ x: 0.5, z: 0 });
  });

  // バグ1/2: 上書き防止
  it('すでに駅があるセルへ再設置しても重複した駅は生成されない', () => {
    let state = emptyState();
    state = applyStation(state, { x: 0, z: 0 });
    const before = state.stations.size;
    state = applyStation(state, { x: 0, z: 0 });

    expect(state.stations.size).toBe(before);
    const cell = state.railMap.get(toKey(0, 0))!;
    expect(cell.type).toBe('station');
  });

  it('車庫セルへ駅を設置しても no-op（車庫は消えない）', () => {
    let state = emptyState();
    state = applyDepot(state, { x: 0, z: 0 });
    const result = applyStation(state, { x: 0, z: 0 });

    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.type).toBe('depot');
    expect(result.stations.size).toBe(0);
  });

  // バグ3: 斜め線路上の駅
  it('斜め線路のセルを駅化すると既存の connections が維持される', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 1 }]);
    const before = state.railMap.get(toKey(0, 0))!;
    expect(before.connections! & DIR.SE).toBe(DIR.SE);

    const result = applyStation(state, { x: 0, z: 0 });
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.type).toBe('station');
    // 既存の斜め connections が維持されている（N|E|S|Wで上書きされていない）
    expect(cell.connections! & DIR.SE).toBe(DIR.SE);
    expect(cell.connections! & DIR.N).toBe(0);
  });

  // 十字乗換駅: 別々に建設された2つの駅が交差セルで1つに統合される
  it('別の駅IDの駅セルを横切ると1つの駅に統合される（十字駅）', () => {
    let state = emptyState();
    // 東西方向の駅(H)を先に建設する(軸を明示。実際のドラッグ方向に相当)
    state = applyStation(state, { x: -1, z: 0 }, undefined, [], 'ew');
    const hId = Array.from(state.stations.keys())[0];
    state = applyStation(state, { x: 0, z: 0 }, undefined, [], 'ew');
    state = applyStation(state, { x: 1, z: 0 }, undefined, [], 'ew');
    expect(state.stations.get(hId)!.cells).toHaveLength(3);

    // 南北方向の駅(V)を、Hに触れないところから独立に建設し、
    // 最後にHの交差セル(0,0)へ向けて延伸させる(十字駅の形成)
    state = applyStation(state, { x: 0, z: -3 }, undefined, [], 'ns');
    const vId = Array.from(state.stations.keys()).find(id => id !== hId)!;
    state = applyStation(state, { x: 0, z: -2 }, undefined, [], 'ns');
    expect(state.stations.get(vId)!.cells).toHaveLength(2);

    // (0,-1)はHの交差セル(0,0)に隣接するため、この時点で統合される
    state = applyStation(state, { x: 0, z: -1 }, undefined, [], 'ns');
    expect(state.stations.size).toBe(1);
    const merged = state.stations.get(hId)!; // 先に存在したHの駅IDが残る
    expect(merged.cells).toHaveLength(6);
    expect(state.stations.has(vId)).toBe(false);

    // 交差セル自体(0,0)はH(ew)としてのみ存在しており、V(ns)は隣接セル(0,-1)止まりで
    // 実際にこのセルを軸として通過していないため、connectionsはew(E|W)のまま。
    // 同じ軸(ew)で再設置しても no-op
    const before = state;
    state = applyStation(state, { x: 0, z: 0 }, undefined, [], 'ew');
    expect(state).toBe(before);

    const crossCell = state.railMap.get(toKey(0, 0))!;
    expect(crossCell.type).toBe('station');
    expect(crossCell.stationId).toBe(hId);
    expect(crossCell.connections).toBe(DIR.E | DIR.W);

    // (0,0)を実際にns軸で横切ると、同じ駅のまま接続だけが十字(cross)に拡張される
    state = applyStation(state, { x: 0, z: 0 }, undefined, [], 'ns');
    const crossedCell = state.railMap.get(toKey(0, 0))!;
    expect(crossedCell.connections).toBe(DIR.N | DIR.E | DIR.S | DIR.W);
    expect(state.stations.size).toBe(1);

    // Vをさらに南へ延伸すると、統合済みの駅として増える
    state = applyStation(state, { x: 0, z: 1 }, undefined, [], 'ns');
    expect(state.stations.get(hId)!.cells).toHaveLength(7);
    expect(state.railMap.get(toKey(0, 1))!.stationId).toBe(hId);
  });

  it('車庫のセルは駅の交差を許可しても従来通り拒否される', () => {
    let state = emptyState();
    state = applyDepot(state, { x: 0, z: 0 });
    const before = state;
    state = applyStation(state, { x: 0, z: 0 });
    expect(state).toBe(before);
    expect(state.railMap.get(toKey(0, 0))!.type).toBe('depot');
  });

  it('高架線(upper)が通るセルに地平駅を置いても upper が消えない', () => {
    // 長さ5の経路: 両端2セルずつが坂、中央(x=0)が橋桁(span/upper)になる
    let state = emptyState();
    state = applyElevatedPath(state, [
      { x: -2, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
    ]);
    const before = state.railMap.get(toKey(0, 0))!;
    expect(before.uppers?.[1]).toBeDefined();

    state = applyStation(state, { x: 0, z: 0 }, undefined, [], 'ns');
    const after = state.railMap.get(toKey(0, 0))!;
    expect(after.type).toBe('station');
    expect(after.uppers?.[1]).toEqual(before.uppers?.[1]);
  });

  it('坂(ramp)のセルに駅を置いても ramp が消えない', () => {
    // (0,0)を地平の既存線路に接続し、長さ4の経路の始点側2セルが坂になるようにする
    let state = emptyState();
    state = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }]);
    state = applyElevatedPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }], undefined, 1);
    const before = state.railMap.get(toKey(0, 0))!;
    expect(before.ramp).toBeDefined();

    state = applyStation(state, { x: 0, z: 0 }, undefined, [], 'ns');
    const after = state.railMap.get(toKey(0, 0))!;
    expect(after.type).toBe('station');
    expect(after.ramp).toEqual(before.ramp);
  });
});

describe('applyStation（町名からの駅名採用）', () => {
  const minamimiya: TownData = { id: 'town-0', name: '南宮市', centre: { x: 0, z: 0 }, population: 1000 };

  it('近くに町があれば町名由来の駅名になる', () => {
    const state = emptyState();
    const result = applyStation(state, { x: 2, z: 0 }, undefined, [minamimiya]);
    const stationId = result.railMap.get(toKey(2, 0))!.stationId!;
    expect(result.stations.get(stationId)!.name).toBe('南宮駅');
  });

  it('同じ町に2つ目の駅を建てると方角つきの名前になる', () => {
    let state = emptyState();
    state = applyStation(state, { x: 2, z: 0 }, undefined, [minamimiya]);
    // 離れた場所に建てるので別の駅になる(町の東側)
    state = applyStation(state, { x: 5, z: 0 }, undefined, [minamimiya]);

    const names = Array.from(state.stations.values()).map(s => s.name).sort();
    expect(names).toEqual(['南宮駅', '東南宮駅']);
  });

  it('近くに町が無ければ従来のA駅/B駅方式になる', () => {
    const state = emptyState();
    const result = applyStation(state, { x: 100, z: 100 }, undefined, [minamimiya]);
    const stationId = result.railMap.get(toKey(100, 100))!.stationId!;
    expect(result.stations.get(stationId)!.name).toBe('A駅');
  });

  it('townsを渡さなければ従来通りA駅/B駅方式になる(後方互換)', () => {
    const state = emptyState();
    const result = applyStation(state, { x: 0, z: 0 });
    const stationId = result.railMap.get(toKey(0, 0))!.stationId!;
    expect(result.stations.get(stationId)!.name).toBe('A駅');
  });
});

describe('nextStationName（バグ5: 採番）', () => {
  it('駅がなければ A駅 になる', () => {
    const stations = new Map<string, StationData>();
    expect(nextStationName(stations)).toBe('A駅');
  });

  it('既存駅の名前を走査し未使用の文字を使う（孤児駅で飛ばない）', () => {
    const stations = new Map<string, StationData>([
      ['id1', { id: 'id1', name: 'A駅', cells: [], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      // B駅 は孤児として消えている想定 → 次は B が再利用されるべき
    ]);
    expect(nextStationName(stations)).toBe('B駅');
  });

  it('A〜Z が全て使われていたら数字サフィックス付きに進む', () => {
    const stations = new Map<string, StationData>();
    for (let i = 0; i < 26; i++) {
      const name = `${String.fromCharCode(65 + i)}駅`;
      stations.set(`id${i}`, { id: `id${i}`, name, cells: [], center: { x: 0, z: 0 }, platformDoors: 'none' });
    }
    expect(nextStationName(stations)).toBe('A2駅');
  });
});

describe('applyDepot（特性テスト・バグ修正）', () => {
  it('空セルには車庫を設置できる', () => {
    const state = emptyState();
    const result = applyDepot(state, { x: 0, z: 0 });
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.type).toBe('depot');
  });

  // バグ1: 駅の上に車庫を置いても駅は消えない
  it('駅セルの上に車庫を設置しても no-op（駅は消えない）', () => {
    let state = emptyState();
    state = applyStation(state, { x: 0, z: 0 });
    const stationCountBefore = state.stations.size;

    const result = applyDepot(state, { x: 0, z: 0 });

    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.type).toBe('station');
    expect(result.stations.size).toBe(stationCountBefore);
  });
});

describe('applySignal（特性テスト）', () => {
  it('rail セルに最初のシグナルを設置すると connections の最初の方向になる', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    const result = applySignal(state, [{ x: 0, z: 0 }]);
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.signalDir).toBe(DIR.E);
  });
});

describe('地形による建設制約（水域・山岳）', () => {
  const waterTerrain = new Map<string, 'water' | 'mountain'>([['0,0', 'water']]);
  const mountainTerrain = new Map<string, 'water' | 'mountain'>([['0,0', 'mountain']]);

  it('水域セルへの駅設置は no-op（stateの参照が変わらない）', () => {
    const state = emptyState();
    const result = applyStation(state, { x: 0, z: 0 }, waterTerrain);
    expect(result).toBe(state);
    expect(result.railMap.has(toKey(0, 0))).toBe(false);
  });

  it('山岳セルへの駅設置は no-op', () => {
    const state = emptyState();
    const result = applyStation(state, { x: 0, z: 0 }, mountainTerrain);
    expect(result).toBe(state);
  });

  it('水域セルへの車庫設置は no-op', () => {
    const state = emptyState();
    const result = applyDepot(state, { x: 0, z: 0 }, waterTerrain);
    expect(result).toBe(state);
    expect(result.railMap.has(toKey(0, 0))).toBe(false);
  });

  it('山岳セルへの車庫設置は no-op', () => {
    const state = emptyState();
    const result = applyDepot(state, { x: 0, z: 0 }, mountainTerrain);
    expect(result).toBe(state);
  });

  it('水域セル(橋)への信号設置は no-op', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }], waterTerrain);
    const result = applySignal(state, [{ x: 0, z: 0 }], waterTerrain);
    expect(result).toBe(state);
  });

  it('平地には従来通り駅・車庫・信号を設置できる（terrain省略時は互換動作）', () => {
    const state = emptyState();
    const stationResult = applyStation(state, { x: 0, z: 0 });
    expect(stationResult.railMap.get(toKey(0, 0))!.type).toBe('station');
  });

  it('水上には線路(橋)を敷設でき、bridgeフラグが立つ', () => {
    const state = emptyState();
    const result = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }], waterTerrain);
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.type).toBe('rail');
    expect(cell.bridge).toBe(true);
    expect(result.railMap.get(toKey(1, 0))!.bridge).toBeFalsy();
  });

  it('山岳には線路(トンネル)を敷設でき、tunnelフラグが立つ', () => {
    const state = emptyState();
    const result = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }], mountainTerrain);
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.type).toBe('rail');
    expect(cell.tunnel).toBe(true);
  });
});

describe('removePath（特性テスト）', () => {
  it('rail を削除すると隣接セルの connections も掃除される', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    const result = removePath(state, [{ x: 0, z: 0 }]);

    expect(result.railMap.has(toKey(0, 0))).toBe(false);
    const neighbour = result.railMap.get(toKey(1, 0))!;
    expect(neighbour.connections! & DIR.W).toBe(0);
  });

  it('駅セルを削除すると駅データからも該当セルが除去される（全セル削除で駅ごと消える）', () => {
    let state = emptyState();
    state = applyStation(state, { x: 0, z: 0 });
    const result = removePath(state, [{ x: 0, z: 0 }]);

    expect(result.railMap.has(toKey(0, 0))).toBe(false);
    expect(result.stations.size).toBe(0);
  });

  it('駅の一部セルだけ削除すると駅は残り center が再計算される', () => {
    let state = emptyState();
    state = applyStation(state, { x: 0, z: 0 });
    state = applyStation(state, { x: 1, z: 0 });
    const stationId = Array.from(state.stations.keys())[0];

    const result = removePath(state, [{ x: 1, z: 0 }]);

    const st = result.stations.get(stationId)!;
    expect(st.cells).toHaveLength(1);
    expect(st.center).toEqual({ x: 0, z: 0 });
  });
});

describe('平面交差（applyRailPath、ダイヤモンドクロッシング）', () => {
  it('直交する線路を後から敷くと4方向接続の1セルになり、upperはできない', () => {
    let state = emptyState();
    // 東西の直線を先に敷く
    state = applyRailPath(state, [{ x: 0, z: 1 }, { x: 1, z: 1 }, { x: 2, z: 1 }]);
    const before = state.railMap.get(toKey(1, 1))!;
    expect(before.connections).toBe(DIR.E | DIR.W);

    // 南北の直線を交差させる(直角でも常に地平のconnectionsへOR)
    state = applyRailPath(state, [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 2 }]);
    const after = state.railMap.get(toKey(1, 1))!;

    // ダイヤモンドクロッシング: 4方向すべてが地平のconnectionsに載る
    expect(after.connections).toBe(DIR.N | DIR.E | DIR.S | DIR.W);
    expect(after.uppers?.[1]).toBeUndefined();
  });

  it('ゆるやかに合流する角度でも従来通り分岐点になる', () => {
    let state = emptyState();
    // 東西の直線
    state = applyRailPath(state, [{ x: 0, z: 1 }, { x: 1, z: 1 }, { x: 2, z: 1 }]);
    // 北東方向から合流(E方向との内積が高い)
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 1 }]);

    const cell = state.railMap.get(toKey(1, 1))!;
    expect(cell.connections! & DIR.NW).toBe(DIR.NW);
    expect(cell.uppers?.[1]).toBeUndefined();
  });

  it('駅セルは平面交差でも type が変化しない(既存の合流挙動のまま)', () => {
    let state = emptyState();
    state = applyStation(state, { x: 1, z: 1 });
    // 駅を東西に貫通させる線路を敷く
    state = applyRailPath(state, [{ x: 0, z: 1 }, { x: 1, z: 1 }, { x: 2, z: 1 }]);
    // 駅を南北に貫通させる
    state = applyRailPath(state, [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 2 }]);

    const cell = state.railMap.get(toKey(1, 1))!;
    expect(cell.type).toBe('station');
    expect(cell.uppers?.[1]).toBeUndefined();
  });

  it('車庫セルは平面交差でも type が変化しない(既存の合流挙動のまま)', () => {
    let state = emptyState();
    state = applyDepot(state, { x: 1, z: 1 });
    state = applyRailPath(state, [{ x: 0, z: 1 }, { x: 1, z: 1 }, { x: 2, z: 1 }]);
    state = applyRailPath(state, [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 2 }]);

    const cell = state.railMap.get(toKey(1, 1))!;
    expect(cell.type).toBe('depot');
    expect(cell.uppers?.[1]).toBeUndefined();
  });

  it('applyRailPathDetailed の overpassCells は常に空(自動高架は廃止済み)', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 1 }, { x: 1, z: 1 }, { x: 2, z: 1 }]);
    const detailed = applyRailPathDetailed(state, [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 2 }]);
    expect(detailed.overpassCells.size).toBe(0);
  });
});
describe('resolveElevatedPathEnd（高架線の端に存在する既存レベル一覧・純粋関数）', () => {
  it('既存の高架(uppers[1].connections)がある位置はlevelsに1を含む', () => {
    let state = emptyState();
    state = applyElevatedPath(state, [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
      { x: 5, z: 0 }, { x: 6, z: 0 }, { x: 7, z: 0 },
    ], undefined, 1);
    const info = resolveElevatedPathEnd(state.railMap, { x: 3, z: 0 });
    expect(info.levels).toEqual([1]);
  });

  it('地平の線路はlevelsに0を含み、空セルはlevelsが空になる', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    expect(resolveElevatedPathEnd(state.railMap, { x: 0, z: 0 }).levels).toEqual([0]);
    expect(resolveElevatedPathEnd(state.railMap, { x: 9, z: 9 }).levels).toEqual([]);
  });
});

describe('pickElevatedConnection（端の接続先レベルの決定・純粋関数）', () => {
  it('建設レベルと同じレベルが既にあればcontinue', () => {
    expect(pickElevatedConnection({ levels: [0, 2] }, 2)).toEqual({ kind: 'continue' });
  });

  it('建設レベルより低いレベルしか無ければ、そのうち最も近い(大きい)ものにconnect', () => {
    expect(pickElevatedConnection({ levels: [0, 1] }, 3)).toEqual({ kind: 'connect', level: 1 });
    expect(pickElevatedConnection({ levels: [0] }, 2)).toEqual({ kind: 'connect', level: 0 });
  });

  it('何も無い、または建設レベルより高いレベルしか無ければflat', () => {
    expect(pickElevatedConnection({ levels: [] }, 2)).toEqual({ kind: 'flat' });
    expect(pickElevatedConnection({ levels: [3] }, 1)).toEqual({ kind: 'flat' });
  });
});

describe('planElevatedPath（高架線の坂/橋桁の役割割り当て・純粋関数）', () => {
  const flat: ElevatedEndPlan = { kind: 'flat' };
  const cont: ElevatedEndPlan = { kind: 'continue' };
  const connect = (level: number): ElevatedEndPlan => ({ kind: 'connect', level });

  it('両端とも浮いた端(flat)なら、坂は1つも無い(すべて橋桁のまま)', () => {
    const plan = planElevatedPath(6, flat, flat, 1);
    expect(plan).not.toBeNull();
    expect(plan!.roles.map(r => r.kind)).toEqual(['span', 'span', 'span', 'span', 'span', 'span']);
  });

  it('始点が地平(level 0)に接続する場合、始点側だけ2セルの坂ができる', () => {
    const plan = planElevatedPath(4, connect(0), flat, 1);
    expect(plan!.roles.map(r => r.kind)).toEqual(['ramp', 'ramp', 'span', 'span']);
    expect(plan!.roles[0]).toEqual({ kind: 'ramp', side: 'start', base: 0, level: 1 });
    expect(plan!.roles[1]).toEqual({ kind: 'ramp', side: 'start', base: 0, level: 2 });
  });

  it('両端とも既存の高架に継ぎ足す場合、坂は1つも無い(すべて橋桁)', () => {
    const plan = planElevatedPath(3, cont, cont, 1);
    expect(plan!.roles.map(r => r.kind)).toEqual(['span', 'span', 'span']);
  });

  it('レベル3への地平接続は、1段差ごとに2セルずつ計6セルの坂になる(base0→base1→base2と積み上がる)', () => {
    const plan = planElevatedPath(10, connect(0), flat, 3);
    expect(plan!.roles.slice(0, 6)).toEqual([
      { kind: 'ramp', side: 'start', base: 0, level: 1 },
      { kind: 'ramp', side: 'start', base: 0, level: 2 },
      { kind: 'ramp', side: 'start', base: 1, level: 1 },
      { kind: 'ramp', side: 'start', base: 1, level: 2 },
      { kind: 'ramp', side: 'start', base: 2, level: 1 },
      { kind: 'ramp', side: 'start', base: 2, level: 2 },
    ]);
    expect(plan!.roles.slice(6).map(r => r.kind)).toEqual(['span', 'span', 'span', 'span']);
  });

  it('坂に必要なセル数が経路長を超える場合はnull', () => {
    expect(planElevatedPath(3, connect(0), connect(0), 1)).toBeNull(); // 両端坂(4セル分)には足りない
    expect(planElevatedPath(1, flat, flat, 1)).toBeNull();
  });

  it('片側だけ坂が必要で、もう片方が継ぎ足しの場合はlength3から成立する(length2以下は継ぎ足し先を坂が潰すためnull)', () => {
    expect(planElevatedPath(3, connect(0), cont, 1)).not.toBeNull();
    expect(planElevatedPath(2, connect(0), cont, 1)).toBeNull();
    expect(planElevatedPath(1, connect(0), cont, 1)).toBeNull();
  });
});

describe('自由に敷ける高架線（applyElevatedPath）', () => {
  it('端が何も無い(浮いた端)場合、坂を作らずそのレベルのままブツ切れで終端する', () => {
    const state = emptyState();
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
      { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    const result = applyElevatedPath(state, path, undefined, 1);

    for (const pos of path) {
      const cell = result.railMap.get(toKey(pos.x, pos.z))!;
      expect(cell.ramp).toBeUndefined();
      expect(cell.uppers?.[1]?.connections).toBeGreaterThan(0);
    }
    expect(result.railMap.get(toKey(0, 0))!.uppers?.[1]?.connections).toBe(DIR.E);
    expect(result.railMap.get(toKey(5, 0))!.uppers?.[1]?.connections).toBe(DIR.W);
  });

  it('曲がる経路にも敷ける(直線という制約が無い)', () => {
    const state = emptyState();
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 1 }, { x: 2, z: 2 },
    ];
    const result = applyElevatedPath(state, path, undefined, 1);
    // 曲がり角の橋桁セル(2,0)はE|W|Sの複数ビットを持つ
    const corner = result.railMap.get(toKey(2, 0))!;
    expect(corner.uppers?.[1]?.connections).toBe(DIR.W | DIR.S);
    // 端は浮いた端なので坂は無い
    expect(result.railMap.get(toKey(0, 0))!.ramp).toBeUndefined();
    expect(result.railMap.get(toKey(2, 2))!.ramp).toBeUndefined();
  });

  it('端を地平の既存線路に接すると、その端だけ坂ができる(地上に接続しない側は浮いた端のまま)', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }]);
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ];
    const result = applyElevatedPath(state, path, undefined, 1);
    expect(result.railMap.get(toKey(0, 0))!.ramp).toBeDefined();
    expect(result.railMap.get(toKey(1, 0))!.ramp).toBeDefined();
    expect(result.railMap.get(toKey(2, 0))!.ramp).toBeUndefined();
    expect(result.railMap.get(toKey(4, 0))!.ramp).toBeUndefined(); // 反対側は浮いた端
    expect(result.railMap.get(toKey(4, 0))!.uppers?.[1]?.connections).toBe(DIR.W);
  });

  it('長い高架(従来のMAX_BRIDGE_LENGTHを超える長さ)も敷ける', () => {
    const state = emptyState();
    const path = Array.from({ length: 20 }, (_, i) => ({ x: i, z: 0 }));
    const result = applyElevatedPath(state, path, undefined, 1);
    expect(result.railMap.get(toKey(10, 0))!.uppers?.[1]?.connections).toBe(DIR.E | DIR.W);
  });

  it('既存の高架の端に継ぎ足すと、継ぎ足し側には坂を作らず高架のまま延伸する', () => {
    let state = emptyState();
    state = applyElevatedPath(state, [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ], undefined, 1);
    expect(state.railMap.get(toKey(2, 0))!.uppers?.[1]?.connections).toBe(DIR.E | DIR.W);

    // (2,0)(橋桁)から北へ延伸する
    const extended = applyElevatedPath(state, [{ x: 2, z: 0 }, { x: 2, z: -1 }, { x: 2, z: -2 }], undefined, 1);
    // 継ぎ足し元(2,0)は既存の橋桁のまま(坂にならない)
    expect(extended.railMap.get(toKey(2, 0))!.ramp).toBeUndefined();
    expect(extended.railMap.get(toKey(2, 0))!.uppers?.[1]?.connections).toBe(DIR.E | DIR.W | DIR.N);
    // 行き止まり側(2,-2)は浮いた端のまま(坂は作らない)
    expect(extended.railMap.get(toKey(2, -2))!.ramp).toBeUndefined();
  });

  it('隣接していない経路はno-op', () => {
    const state = emptyState();
    const result = applyElevatedPath(state, [{ x: 0, z: 0 }, { x: 5, z: 0 }], undefined, 1);
    expect(result).toBe(state);
  });

  it('橋桁になるセルが車庫の場合はno-op', () => {
    let state = emptyState();
    state = applyDepot(state, { x: 2, z: 0 });
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const result = applyElevatedPath(state, path, undefined, 1);
    expect(result).toBe(state);
  });

  it('橋桁になるセルに既にupperがある場合はno-op(二重架け禁止)', () => {
    let state = emptyState();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    state = applyElevatedPath(state, path, undefined, 1);
    expect(state.railMap.get(toKey(2, 0))!.uppers?.[1]).toBeDefined();

    const crossing = [{ x: 2, z: -2 }, { x: 2, z: -1 }, { x: 2, z: 0 }, { x: 2, z: 1 }, { x: 2, z: 2 }];
    const result = applyElevatedPath(state, crossing, undefined, 1);
    expect(result).toBe(state);
  });

  it('坂になるセルが水域・山岳の場合はno-op', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }]);
    const terrain = new Map<string, TerrainType>([[toKey(0, 0), 'water']]);
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const result = applyElevatedPath(state, path, terrain, 1);
    expect(result).toBe(state);
  });

  it('橋桁の下に既存の地平線路があっても地平connectionsは変化しない(下を跨げる)', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 2, z: -1 }, { x: 2, z: 0 }, { x: 2, z: 1 }]);
    const beforeGround = state.railMap.get(toKey(2, 0))!.connections;

    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const result = applyElevatedPath(state, path, undefined, 1);
    const mid = result.railMap.get(toKey(2, 0))!;
    expect(mid.connections).toBe(beforeGround);
    expect(mid.uppers?.[1]?.connections).toBe(DIR.E | DIR.W);
  });

  it('橋桁の下に後から地平の線路を敷ける(高架は既存のまま)', () => {
    let state = emptyState();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    state = applyElevatedPath(state, path, undefined, 1);
    const result = applyRailPath(state, [{ x: 2, z: -1 }, { x: 2, z: 0 }, { x: 2, z: 1 }]);
    const mid = result.railMap.get(toKey(2, 0))!;
    expect(mid.uppers?.[1]?.connections).toBe(DIR.E | DIR.W);
    expect(mid.connections! & DIR.N).toBe(DIR.N);
    expect(mid.connections! & DIR.S).toBe(DIR.S);
  });

  it('水域の上にも高架線を敷ける(橋の役割を兼ねる)', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }]);
    const terrain = new Map<string, TerrainType>([[toKey(2, 0), 'water']]);
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const result = applyElevatedPath(state, path, terrain, 1);
    expect(result.railMap.get(toKey(2, 0))!.uppers?.[1]?.connections).toBe(DIR.E | DIR.W);
  });
});

describe('applyBridge（旧APIの後方互換ラッパー）', () => {
  it('applyElevatedPathと同じ結果になる(新規の直線区間)', () => {
    const state = emptyState();
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
      { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    const result = applyBridge(state, path);
    expect(result.railMap.get(toKey(0, 0))!.ramp).toEqual({ dir: DIR.E, level: 1, base: 0 });
    expect(result.railMap.get(toKey(2, 0))!.uppers?.[1]?.connections).toBe(DIR.E | DIR.W);
  });
});

describe('高架駅タイル（applyElevatedStation）', () => {
  it('高架の線路が無いセルへは置けない(no-op)', () => {
    const state = emptyState();
    const result = applyElevatedStation(state, { x: 0, z: 0 });
    expect(result).toBe(state);
  });

  it('高架の線路セルに置くと、そのセルがupper.stationIdを持つ新しい高架駅になる', () => {
    let state = emptyState();
    state = applyElevatedPath(state, [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ]);
    const result = applyElevatedStation(state, { x: 2, z: 0 });
    const cell = result.railMap.get(toKey(2, 0))!;
    expect(cell.uppers?.[1]?.stationId).toBeDefined();
    const st = result.stations.get(cell.uppers?.[1]!.stationId!)!;
    expect(st.cells).toEqual([{ x: 2, z: 0, layer: 1 }]);
  });

  it('隣接する高架駅セルへ置くと、既存の高架駅に統合される', () => {
    let state = emptyState();
    state = applyElevatedPath(state, [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ]);
    state = applyElevatedStation(state, { x: 2, z: 0 });
    const stationId = state.railMap.get(toKey(2, 0))!.uppers?.[1]!.stationId!;

    const result = applyElevatedStation(state, { x: 3, z: 0 });
    const st = result.stations.get(stationId)!;
    expect(st.cells).toEqual(
      expect.arrayContaining([{ x: 2, z: 0, layer: 1 }, { x: 3, z: 0, layer: 1 }])
    );
    expect(st.cells.length).toBe(2);
  });

  it('同じ(x,z)に地平駅セルがあれば、同一駅IDに統合される(立体交差の十字乗換駅)', () => {
    let state = emptyState();
    state = applyStation(state, { x: 2, z: 0 }, undefined, [], 'ns');
    const groundBefore = state.railMap.get(toKey(2, 0))!.connections;
    const groundStationId = state.railMap.get(toKey(2, 0))!.stationId!;

    state = applyElevatedPath(state, [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ]);
    const result = applyElevatedStation(state, { x: 2, z: 0 });

    const crossing = result.railMap.get(toKey(2, 0))!;
    expect(crossing.type).toBe('station'); // 地平のtype/接続はそのまま
    expect(crossing.connections).toBe(groundBefore);
    expect(crossing.stationId).toBe(groundStationId);
    expect(crossing.uppers?.[1]?.stationId).toBe(groundStationId);

    const st = result.stations.get(groundStationId)!;
    expect(st.cells).toEqual(
      expect.arrayContaining([
        { x: 2, z: 0 },
        { x: 2, z: 0, layer: 1 },
      ])
    );
  });

  it('既に高架駅のセルへ再設置してもno-op', () => {
    let state = emptyState();
    state = applyElevatedPath(state, [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ]);
    state = applyElevatedStation(state, { x: 2, z: 0 });
    const result = applyElevatedStation(state, { x: 2, z: 0 });
    expect(result).toBe(state);
  });
});

describe('高架セル1枚の撤去（removePath）', () => {
  it('橋桁セル1枚だけを撤去でき、他の高架セルは残る(旧・橋全体撤去は廃止)', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }]);
    state = applyRailPath(state, [{ x: 7, z: 0 }, { x: 8, z: 0 }]);
    const path = Array.from({ length: 8 }, (_, i) => ({ x: i, z: 0 }));
    state = applyElevatedPath(state, path, undefined, 1);
    // 橋桁は index 2..5 (0,1,6,7が坂)
    expect(state.railMap.get(toKey(3, 0))!.uppers?.[1]).toBeDefined();

    const result = removePath(state, [{ x: 3, z: 0 }]);
    expect(result.railMap.get(toKey(3, 0))).toBeUndefined();
    // 他の橋桁・坂セルは残る
    expect(result.railMap.get(toKey(2, 0))!.uppers?.[1]).toBeDefined();
    expect(result.railMap.get(toKey(4, 0))!.uppers?.[1]).toBeDefined();
    expect(result.railMap.get(toKey(0, 0))!.ramp).toBeDefined();
  });

  it('坂の行き先(橋桁)が撤去で無くなった場合、坂も地平の線路に戻る', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }]);
    state = applyRailPath(state, [{ x: 4, z: 0 }, { x: 5, z: 0 }]);
    // 坂2 + 橋桁1 + 坂2 = 長さ5
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    state = applyElevatedPath(state, path, undefined, 1);
    expect(state.railMap.get(toKey(1, 0))!.ramp).toBeDefined();

    // 唯一の橋桁(2,0)を撤去する
    const result = removePath(state, [{ x: 2, z: 0 }]);
    expect(result.railMap.get(toKey(2, 0))).toBeUndefined();
    // 行き先を失った坂(1,0)は地平の通常線路に戻る(rampが外れる、connectionsは残る)
    expect(result.railMap.get(toKey(1, 0))!.ramp).toBeUndefined();
    expect(result.railMap.get(toKey(1, 0))!.type).toBe('rail');
    expect(result.railMap.get(toKey(3, 0))!.ramp).toBeUndefined();
  });

  it('橋桁セルの下に独立した地平線路がある場合、upperだけ消えて地平線路は残る', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 2, z: -1 }, { x: 2, z: 0 }, { x: 2, z: 1 }]);
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    state = applyElevatedPath(state, path);

    const result = removePath(state, [{ x: 2, z: 0 }]);
    const cell = result.railMap.get(toKey(2, 0))!;
    expect(cell).toBeDefined();
    expect(cell.uppers?.[1]).toBeUndefined();
    expect(cell.connections! & DIR.N).toBe(DIR.N);
    expect(cell.connections! & DIR.S).toBe(DIR.S);
  });

  it('高架駅セルを撤去すると、そのセルだけがstationsから消える', () => {
    let state = emptyState();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    state = applyElevatedPath(state, path);
    state = applyElevatedStation(state, { x: 2, z: 0 });
    const stationId = state.railMap.get(toKey(2, 0))!.uppers?.[1]!.stationId!;

    const result = removePath(state, [{ x: 2, z: 0 }]);
    expect(result.stations.get(stationId)).toBeUndefined();
  });
});

describe('多レベル高架(level 2/3)', () => {
  it('端が空(浮いた端): レベル2建設で坂0・全セルがuppers[2]になる', () => {
    const state = emptyState();
    const path = Array.from({ length: 6 }, (_, i) => ({ x: i, z: 0 }));
    const result = applyElevatedPath(state, path, undefined, 2);
    for (const pos of path) {
      const cell = result.railMap.get(toKey(pos.x, pos.z))!;
      expect(cell.ramp).toBeUndefined();
      expect(cell.uppers?.[2]?.connections).toBeGreaterThan(0);
    }
  });

  it('端が地上(level 0)の既存線路: レベル2建設でその端に坂4セル(base0,base1)ができる', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }]);
    const path = Array.from({ length: 8 }, (_, i) => ({ x: i, z: 0 }));
    const result = applyElevatedPath(state, path, undefined, 2);
    expect(result.railMap.get(toKey(0, 0))!.ramp).toEqual({ dir: DIR.E, level: 1, base: 0 });
    expect(result.railMap.get(toKey(1, 0))!.ramp).toEqual({ dir: DIR.E, level: 2, base: 0 });
    expect(result.railMap.get(toKey(2, 0))!.ramp).toEqual({ dir: DIR.E, level: 1, base: 1 });
    expect(result.railMap.get(toKey(3, 0))!.ramp).toEqual({ dir: DIR.E, level: 2, base: 1 });
    expect(result.railMap.get(toKey(4, 0))!.uppers?.[2]?.connections).toBeGreaterThan(0);
    // 反対側は浮いた端のまま
    expect(result.railMap.get(toKey(7, 0))!.ramp).toBeUndefined();
  });

  it('端が既存のレベル1線路: レベル2建設でその端に坂2セル(base1)だけができる', () => {
    // (0,0)にだけレベル1の桁があり、そこからレベル2の経路を延ばす(反対側は浮いた端のまま)。
    let state = emptyState();
    state = applyElevatedPath(state, [{ x: -3, z: 0 }, { x: -2, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 0 }], undefined, 1);
    const path = Array.from({ length: 6 }, (_, i) => ({ x: i, z: 0 }));
    const result = applyElevatedPath(state, path, undefined, 2);
    expect(result.railMap.get(toKey(0, 0))!.ramp).toEqual({ dir: DIR.E, level: 1, base: 1 });
    expect(result.railMap.get(toKey(1, 0))!.ramp).toEqual({ dir: DIR.E, level: 2, base: 1 });
    expect(result.railMap.get(toKey(2, 0))!.ramp).toBeUndefined();
    expect(result.railMap.get(toKey(5, 0))!.ramp).toBeUndefined(); // 反対側は浮いた端
  });

  it('端が同じレベル2の既存線路: 坂なしで継ぎ足す', () => {
    let state = emptyState();
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i, z: 0 })), undefined, 2);
    const extended = applyElevatedPath(state, [{ x: 5, z: 0 }, { x: 6, z: 0 }, { x: 7, z: 0 }], undefined, 2);
    expect(extended.railMap.get(toKey(5, 0))!.ramp).toBeUndefined();
    expect(extended.railMap.get(toKey(7, 0))!.ramp).toBeUndefined(); // 新たな浮いた端
    expect(extended.railMap.get(toKey(5, 0))!.uppers?.[2]?.connections).toBe(DIR.W | DIR.E);
  });

  it('pickElevatedConnection: レベル1とレベル0が両方ある端では、より近いレベル1に接続する', () => {
    expect(pickElevatedConnection({ levels: [0, 1] }, 2)).toEqual({ kind: 'connect', level: 1 });
  });

  // 長さ10の経路(浮いた端の橋桁のみ)を使う: 全セルが橋桁(span)になる。
  const tenCellPath = Array.from({ length: 10 }, (_, i) => ({ x: i, z: 0 }));

  it('applyElevatedPath: レベル2の桁はuppers[2]に入り、レベル1とは独立して併存できる', () => {
    let state = emptyState();
    // まずレベル1の高架線を敷く(x=4,5が橋桁)
    state = applyElevatedPath(state, tenCellPath, undefined, 1);
    expect(state.railMap.get(toKey(4, 0))!.uppers?.[1]?.connections).toBe(DIR.E | DIR.W);
    // 同じ座標にレベル2の高架線を重ねて敷く(別レベルなので併存できる)
    const result = applyElevatedPath(state, tenCellPath, undefined, 2);
    expect(result.railMap).not.toBe(state.railMap);
    const mid = result.railMap.get(toKey(4, 0))!;
    expect(mid.uppers?.[1]?.connections).toBe(DIR.E | DIR.W);
    expect(mid.uppers?.[2]?.connections).toBe(DIR.E | DIR.W);
  });

  it('applyElevatedPath: 同一レベルへの二重架けはno-op', () => {
    let state = emptyState();
    state = applyElevatedPath(state, tenCellPath, undefined, 2);
    const before = state;
    state = applyElevatedPath(state, tenCellPath, undefined, 2);
    expect(state).toBe(before);
  });

  it('applyElevatedStation: レベル2の高架線にレベル2の駅を置ける', () => {
    let state = emptyState();
    state = applyElevatedPath(state, tenCellPath, undefined, 2);
    const result = applyElevatedStation(state, { x: 4, z: 0 }, [], 2);
    const cell = result.railMap.get(toKey(4, 0))!;
    expect(cell.uppers?.[2]?.stationId).toBeDefined();
    expect(cell.uppers?.[1]).toBeUndefined();
  });
});

describe('地平の線路(applyRailPath)が浮いた高架の端に自動で坂を作って接続する', () => {
  it('pickElevatedConnection: level=0は自分より高い既存レベルのうち最も近い(最小の)ものへconnectする', () => {
    expect(pickElevatedConnection({ levels: [2] }, 0)).toEqual({ kind: 'connect', level: 2 });
    expect(pickElevatedConnection({ levels: [1, 3] }, 0)).toEqual({ kind: 'connect', level: 1 });
    expect(pickElevatedConnection({ levels: [] }, 0)).toEqual({ kind: 'flat' });
    expect(pickElevatedConnection({ levels: [0] }, 0)).toEqual({ kind: 'continue' });
  });

  it('planElevatedPath: level=0でconnect(level:2)の端には、坂4セル(base1→base0の降順)が割り当てられる', () => {
    const plan = planElevatedPath(6, { kind: 'flat' }, { kind: 'connect', level: 2 }, 0);
    expect(plan).not.toBeNull();
    expect(plan!.roles.map(r => r.kind)).toEqual(['span', 'span', 'ramp', 'ramp', 'ramp', 'ramp']);
    // 接続先(既存レベル2)に近い側から: base1(level2側)→base0(地平側)の順に降りる
    expect(plan!.roles[2]).toEqual({ kind: 'ramp', side: 'end', base: 0, level: 1 });
    expect(plan!.roles[3]).toEqual({ kind: 'ramp', side: 'end', base: 0, level: 2 });
    expect(plan!.roles[4]).toEqual({ kind: 'ramp', side: 'end', base: 1, level: 1 });
    expect(plan!.roles[5]).toEqual({ kind: 'ramp', side: 'end', base: 1, level: 2 });
  });

  it('端が空(浮いた高架が無い): 従来通りの平坦な地平線路のまま', () => {
    const state = emptyState();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const result = applyRailPath(state, path);
    for (const pos of path) {
      const cell = result.railMap.get(toKey(pos.x, pos.z))!;
      expect(cell.ramp).toBeUndefined();
      expect(cell.uppers).toBeUndefined();
    }
  });

  it('端を浮いた高架(レベル1)の端タイルに当てると、その端だけ坂2セルで自動接続される', () => {
    let state = emptyState();
    // レベル1の浮いた高架(両端とも接続先なし)を(4,0)〜(9,0)に敷く
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, 1);
    expect(state.railMap.get(toKey(4, 0))!.uppers?.[1]?.connections).toBeGreaterThan(0);

    // 地平の線路を(0,0)から高架の端タイル(4,0)まで引く
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const result = applyRailPath(state, path);

    // 接続先(4,0)に近い2セル(3,0)(4,0)が坂になり、遠い側(0,0)(1,0)(2,0)は
    // 平坦な地平線路のまま
    expect(result.railMap.get(toKey(0, 0))!.ramp).toBeUndefined();
    expect(result.railMap.get(toKey(1, 0))!.ramp).toBeUndefined();
    expect(result.railMap.get(toKey(2, 0))!.ramp).toBeUndefined();
    expect(result.railMap.get(toKey(3, 0))!.ramp).toBeDefined();

    // アンカーセル(4,0)は既存のuppers[1]がそのまま残りつつ、新しい方向(西=坂側)のビットが追加される
    const anchor = result.railMap.get(toKey(4, 0))!;
    expect(anchor.uppers?.[1]?.connections).toBeDefined();
    expect((anchor.uppers![1]!.connections & DIR.W)).toBe(DIR.W);
    // 既存の桁の東方向の接続(高架内部)は保持されたまま
    expect((anchor.uppers![1]!.connections & DIR.E)).toBe(DIR.E);
  });

  it('端を浮いた高架(レベル2)の端タイルに当てると、坂4セルで接続される', () => {
    let state = emptyState();
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 6, z: 0 })), undefined, 2);
    const path = Array.from({ length: 7 }, (_, i) => ({ x: i, z: 0 })); // 0..6, 6が高架の端タイル
    const result = applyRailPath(state, path);

    let rampCount = 0;
    for (const pos of path) {
      if (result.railMap.get(toKey(pos.x, pos.z))?.ramp) rampCount++;
    }
    expect(rampCount).toBe(4);
    const anchor = result.railMap.get(toKey(6, 0))!;
    expect((anchor.uppers![2]!.connections & DIR.W)).toBe(DIR.W);
  });

  it('接続先が無ければ、経路の途中にたまたま高架があっても影響しない(端だけを見る)', () => {
    let state = emptyState();
    // 高架(レベル1)を経路と関係ない場所(z=5)に浮かせて置く
    state = applyElevatedPath(state, Array.from({ length: 4 }, (_, i) => ({ x: i, z: 5 })), undefined, 1);
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const result = applyRailPath(state, path);
    for (const pos of path) {
      expect(result.railMap.get(toKey(pos.x, pos.z))!.ramp).toBeUndefined();
    }
  });

  it('坂になるセルが水域・山岳の場合は、接続を諦めて平坦な地平線路にフォールバックする', () => {
    let state = emptyState();
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, 1);
    const terrain = new Map<string, TerrainType>([[toKey(3, 0), 'water']]);
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const result = applyRailPath(state, path, terrain);
    // 坂は作られず(水域のため)、代わりに平坦な地平線路として敷かれる
    for (const pos of path) {
      expect(result.railMap.get(toKey(pos.x, pos.z))!.ramp).toBeUndefined();
    }
    expect(result.railMap.get(toKey(0, 0))!.connections).toBeGreaterThan(0);
  });

  it('坂になるセルが車庫の場合は、接続を諦めて平坦な地平線路にフォールバックする', () => {
    let state = emptyState();
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, 1);
    state = applyDepot(state, { x: 3, z: 0 });
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const result = applyRailPath(state, path);
    expect(result.railMap.get(toKey(3, 0))!.type).toBe('depot');
    expect(result.railMap.get(toKey(2, 0))!.ramp).toBeUndefined();
  });

  it('接続後、経路探索(BFS)で地平の始点から高架駅まで到達できる', () => {
    let state = emptyState();
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, 1);
    state = applyElevatedStation(state, { x: 7, z: 0 }, []);
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const result = applyRailPath(state, path);
    const stationId = result.railMap.get(toKey(7, 0))!.uppers![1]!.stationId!;
    expect(stationId).toBeDefined();
  });

  it('斜め(対角)方向の直線なら坂で問題なく接続できる(直線制限は斜めを禁止しない)', () => {
    let state = emptyState();
    // 高架(レベル1)を対角(NE)方向に浮かせて敷く
    state = applyElevatedPath(
      state,
      Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: -i - 4 })),
      undefined, 1
    );
    // 地平の線路を同じ対角方向で高架の端タイル(4,-4)まで引く
    const path = [{ x: 0, z: 0 }, { x: 1, z: -1 }, { x: 2, z: -2 }, { x: 3, z: -3 }, { x: 4, z: -4 }];
    const result = applyRailPath(state, path);
    expect(result.railMap.get(toKey(3, -3))!.ramp).toBeDefined();
    expect(result.railMap.get(toKey(4, -4))!.ramp).toBeDefined();
    expect((result.railMap.get(toKey(4, -4))!.uppers![1]!.connections & DIR.SW)).toBe(DIR.SW);
  });

  it('坂の区間でカーブ(方向転換)していると、接続を諦めて平坦な地平線路にフォールバックする', () => {
    let state = emptyState();
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, 1);
    // 坂になるはずの区間((3,0)→(4,0)の手前)でカーブする経路: (2,0)から北へ折れてから
    // 東へ戻り(4,0)へ到達する形にする。
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 2, z: -1 }, { x: 3, z: -1 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ];
    const result = applyRailPath(state, path);
    // 坂は作られず(直線制限のため)、平坦な地平線路として敷かれる
    for (const pos of path) {
      expect(result.railMap.get(toKey(pos.x, pos.z))!.ramp).toBeUndefined();
    }
    expect(result.railMap.get(toKey(0, 0))!.connections).toBeGreaterThan(0);
    // 接続先の既存高架はカーブ経路によって書き換えられていない
    expect(result.railMap.get(toKey(4, 0))!.uppers?.[1]?.connections).toBe(
      state.railMap.get(toKey(4, 0))!.uppers![1]!.connections
    );
  });

  it('planHasStraightRamps: 坂セルでカーブしているとfalseを返す', () => {
    // 長さ5、末尾2セル(index3,4)が坂(base0)になる。index3で北→東へカーブする。
    const path = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 1 }, { x: 3, z: 1 },
    ];
    const plan = planElevatedPath(path.length, { kind: 'flat' }, { kind: 'connect', level: 1 }, 0);
    expect(plan).not.toBeNull();
    expect(planHasStraightRamps(path, plan!)).toBe(false);
  });

  it('planHasStraightRamps: 直線の坂区間ならtrueを返す', () => {
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }];
    const plan = planElevatedPath(path.length, { kind: 'flat' }, { kind: 'connect', level: 1 }, 0);
    expect(plan).not.toBeNull();
    expect(planHasStraightRamps(path, plan!)).toBe(true);
  });
});

describe('高架建設(applyElevatedPath)の坂も直線区間のみに制限される', () => {
  it('坂の区間でカーブしていると、高架建設全体がno-opになる', () => {
    let state = emptyState();
    // 地平の既存線路(継ぎ足し元)を(0,0)〜(1,0)に敷く
    state = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }]);
    // (0,0)から坂(2セル分)の区間でカーブしてから橋桁へ続く経路
    const path = [
      { x: 0, z: 0 }, { x: 0, z: -1 }, { x: 1, z: -1 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 },
    ];
    const result = applyElevatedPath(state, path, undefined, 1);
    expect(result).toBe(state);
  });
});

describe('坂セルは、別々の建設で後から直交する接続を足されても壊れない', () => {
  it('坂の軸と異なる方向で交差する線路を後から引いても、その建設はno-opになり坂は壊れない', () => {
    let state = emptyState();
    // 浮いた高架(レベル1)を(4,0)〜(9,0)に敷く
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, 1);
    // 地平の線路を(0,0)から高架の端タイル(4,0)まで引き、(3,0)(4,0)を坂にする
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }]);
    const rampCellBefore = state.railMap.get(toKey(3, 0))!;
    expect(rampCellBefore.ramp).toBeDefined();

    // 後から、坂セル(3,0)を南北方向に貫く別の線路を引く(1回目の建設とは無関係の別ドラッグ)
    const before = state.railMap;
    const result = applyRailPath(state, [{ x: 3, z: -2 }, { x: 3, z: -1 }, { x: 3, z: 0 }, { x: 3, z: 1 }, { x: 3, z: 2 }]);

    // 建設全体がno-opになり、坂セルのデータは一切変化しない
    expect(result.railMap).toBe(before);
    expect(result.railMap.get(toKey(3, 0))).toEqual(rampCellBefore);
  });

  it('坂の軸と同じ方向(継ぎ足し)なら、後から重ねて引いても問題ない', () => {
    let state = emptyState();
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, 1);
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }]);
    // 同じ軸(東西)方向で、坂セルを含む区間を重ねて引き直す
    const result = applyRailPath(state, [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }]);
    expect(result.railMap.get(toKey(3, 0))!.ramp).toBeDefined();
  });
});
