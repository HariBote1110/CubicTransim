import { describe, expect, it } from 'vitest';
import { DIR, toKey } from '../utils';
import type { CellData, StationData, TerrainType } from '../types';
import {
  applyRailPath,
  applyRailPathDetailed,
  applyStation,
  applyDepot,
  applySignal,
  applyBridge,
  removePath,
  nextStationName,
  MAX_BRIDGE_LENGTH,
  type ConstructionState,
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
  it('空セルに駅を設置すると新しい駅IDと N|E|S|W の connections を持つ', () => {
    const state = emptyState();
    const result = applyStation(state, { x: 0, z: 0 });
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.type).toBe('station');
    expect(cell.connections).toBe(DIR.N | DIR.E | DIR.S | DIR.W);
    expect(result.stations.size).toBe(1);
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
    expect(after.upper).toBeUndefined();
  });

  it('ゆるやかに合流する角度でも従来通り分岐点になる', () => {
    let state = emptyState();
    // 東西の直線
    state = applyRailPath(state, [{ x: 0, z: 1 }, { x: 1, z: 1 }, { x: 2, z: 1 }]);
    // 北東方向から合流(E方向との内積が高い)
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 1 }]);

    const cell = state.railMap.get(toKey(1, 1))!;
    expect(cell.connections! & DIR.NW).toBe(DIR.NW);
    expect(cell.upper).toBeUndefined();
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
    expect(cell.upper).toBeUndefined();
  });

  it('車庫セルは平面交差でも type が変化しない(既存の合流挙動のまま)', () => {
    let state = emptyState();
    state = applyDepot(state, { x: 1, z: 1 });
    state = applyRailPath(state, [{ x: 0, z: 1 }, { x: 1, z: 1 }, { x: 2, z: 1 }]);
    state = applyRailPath(state, [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 2 }]);

    const cell = state.railMap.get(toKey(1, 1))!;
    expect(cell.type).toBe('depot');
    expect(cell.upper).toBeUndefined();
  });

  it('applyRailPathDetailed の overpassCells は常に空(自動高架は廃止済み)', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 1 }, { x: 1, z: 1 }, { x: 2, z: 1 }]);
    const detailed = applyRailPathDetailed(state, [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 2 }]);
    expect(detailed.overpassCells.size).toBe(0);
  });
});

describe('橋（applyBridge）', () => {
  it('直線の始点・終点が橋台(地平のconnections)、中間セルが橋桁(upper)になる', () => {
    const state = emptyState();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }];
    const result = applyBridge(state, path);

    // 橋台(始点・終点)は地平の通常線路
    const start = result.railMap.get(toKey(0, 0))!;
    const end = result.railMap.get(toKey(3, 0))!;
    expect(start.type).toBe('rail');
    expect(start.connections! & DIR.E).toBe(DIR.E);
    expect(start.upper).toBeUndefined();
    expect(end.connections! & DIR.W).toBe(DIR.W);
    expect(end.upper).toBeUndefined();

    // 橋桁(中間セル)はupperにのみ接続を持ち、地平のconnectionsは変化しない
    const mid1 = result.railMap.get(toKey(1, 0))!;
    const mid2 = result.railMap.get(toKey(2, 0))!;
    expect(mid1.connections ?? 0).toBe(0);
    expect(mid1.upper?.connections).toBe(DIR.E | DIR.W);
    expect(mid2.connections ?? 0).toBe(0);
    expect(mid2.upper?.connections).toBe(DIR.E | DIR.W);
  });

  it('橋の下に既存の地平線路があっても地平connectionsは変化しない', () => {
    let state = emptyState();
    // 橋桁の下に南北の地平線路を先に敷いておく
    state = applyRailPath(state, [{ x: 1, z: -1 }, { x: 1, z: 0 }, { x: 1, z: 1 }]);
    const beforeGround = state.railMap.get(toKey(1, 0))!.connections;

    const result = applyBridge(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }]);
    const mid = result.railMap.get(toKey(1, 0))!;
    expect(mid.connections).toBe(beforeGround);
    expect(mid.upper?.connections).toBe(DIR.E | DIR.W);
  });

  it('始点と終点が直線上にない場合はno-op', () => {
    const state = emptyState();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 1 }];
    const result = applyBridge(state, path);
    expect(result.railMap).toBe(state.railMap);
  });

  it('全長がMAX_BRIDGE_LENGTHを超える場合はno-op', () => {
    const state = emptyState();
    const path = Array.from({ length: MAX_BRIDGE_LENGTH + 2 }, (_, i) => ({ x: i, z: 0 }));
    const result = applyBridge(state, path);
    expect(result.railMap).toBe(state.railMap);
  });

  it('全長が3未満(橋桁ゼロ)の場合はno-op', () => {
    const state = emptyState();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }];
    const result = applyBridge(state, path);
    expect(result.railMap).toBe(state.railMap);
  });

  it('橋桁になるセルが駅・車庫セルの場合はno-op', () => {
    let state = emptyState();
    state = applyStation(state, { x: 1, z: 0 });
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const result = applyBridge(state, path);
    expect(result.railMap).toBe(state.railMap);
  });

  it('橋桁になるセルに既にupperがある場合はno-op(二重架け禁止)', () => {
    let state = emptyState();
    state = applyBridge(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }]);
    expect(state.railMap.get(toKey(1, 0))!.upper).toBeDefined();

    const result = applyBridge(state, [{ x: 1, z: -1 }, { x: 1, z: 0 }, { x: 1, z: 1 }]);
    expect(result.railMap).toBe(state.railMap);
  });

  it('橋台になるセルが水域・山岳の場合はno-op', () => {
    const state = emptyState();
    const terrain = new Map<string, TerrainType>([[toKey(0, 0), 'water']]);
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const result = applyBridge(state, path, terrain);
    expect(result.railMap).toBe(state.railMap);
  });

  it('撤去で橋桁セルのupperだけ消え、地平の線路は残る', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 1, z: -1 }, { x: 1, z: 0 }, { x: 1, z: 1 }]);
    state = applyBridge(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }]);
    expect(state.railMap.get(toKey(1, 0))!.upper).toBeDefined();

    const result = removePath(state, [{ x: 1, z: 0 }]);
    const cell = result.railMap.get(toKey(1, 0))!;
    expect(cell).toBeDefined();
    expect(cell.upper).toBeUndefined();
    expect(cell.connections! & DIR.N).toBe(DIR.N);
    expect(cell.connections! & DIR.S).toBe(DIR.S);
  });
});
