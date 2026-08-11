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
  applyUndergroundPath,
  applyUndergroundStation,
  removePath,
  nextStationName,
  resolveElevatedPathEnd,
  planElevatedPath,
  pickElevatedConnection,
  planHasStraightRamps,
  resolveGroundRailPlanDetailed,
  type ConstructionState,
  type ElevatedEndPlan,
  type ElevatedPathPlan,
  type BuildLevel,
} from './construction';
import { fieldFromMaps } from './terrainField';
import type { TerrainField } from './terrainField';
import { computeElevation } from './testSupport/elevationFixture';

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

  // バグ報告: 既存の東西線路上でクリック設置したのに、ドラッグ方向の誤差(軸ヒント)が
  // 直交方向として拾われ、実在しない南北connectionsが混入してホームが線路と直交してしまう。
  // ヒントより実際のconnections/隣接セルの構造を優先すべき。
  it('既存の東西線路セルに南北ヒント付きで設置しても、実際の東西connectionsが優先される', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }]);
    // ドラッグの微妙なブレでaxis='ns'ヒントが渡ってしまうケースを再現
    const result = applyStation(state, { x: 0, z: 0 }, undefined, [], 'ns');
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.connections).toBe(DIR.E | DIR.W);
    expect(cell.connections! & DIR.N).toBe(0);
    expect(cell.connections! & DIR.S).toBe(0);
  });

  it('既存の南北線路セルに東西ヒント付きで設置しても、実際の南北connectionsが優先される', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: -1 }, { x: 0, z: 0 }, { x: 0, z: 1 }]);
    const result = applyStation(state, { x: 0, z: 0 }, undefined, [], 'ew');
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.connections).toBe(DIR.N | DIR.S);
    expect(cell.connections! & DIR.E).toBe(0);
    expect(cell.connections! & DIR.W).toBe(0);
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

  it('坂(ramp)のセルに駅を置いても ramp が消えない(設置自体がno-opになる)', () => {
    // (0,0)を地平の既存線路に接続し、長さ4の経路の始点側2セルが坂になるようにする
    let state = emptyState();
    state = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }]);
    state = applyElevatedPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }], undefined, 1);
    const before = state.railMap.get(toKey(0, 0))!;
    expect(before.ramp).toBeDefined();

    // 坂セルは直線の斜面専用なので駅は置けない。以前は「駅化しつつrampを保持」して
    // いたが、駅の軸ビット(ここではns)が坂の軸(ew)と直交して描画できない状態に
    // 壊れるため、設置全体をno-op(同一state参照)にする。rampは当然消えない。
    const result = applyStation(state, { x: 0, z: 0 }, undefined, [], 'ns');
    expect(result).toBe(state);
    const after = result.railMap.get(toKey(0, 0))!;
    expect(after.type).toBe('rail');
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

describe('地形による建設制約（水域・傾斜） P7bで更新', () => {
  const waterTerrain = fieldFromMaps(new Map(), new Map<string, 'water' | 'mountain'>([['0,0', 'water']]), 45);
  // terrainTypeAtが'mountain'を返すだけの旧mountainTerrain(heights未設定=4隅とも標高0の
  // 完全な平坦)は、P7bでは「mountainは表示上の分類にすぎず、実際の建設可否はコーナー標高
  // (slopeOf)で決まる」という設計変更により、駅・車庫・線路すべて建設できるようになった
  // (mountainCosmeticTerrainのテストで検証)。建設拒否の実例には、実際に傾斜している
  // (flatでない)inclineTerrainを使う。
  //
  // inclineTerrain: z=0,1の帯を標高1にし、z=-1側との境界(0,0)をinclineセル(南北方向のみ
  // 接続可)にする。3行必要な理由はmakeBlockTerrain同様、min則コーナー導出では1セル幅の
  // 孤立した高さでは4隅とも標高0に潰れてしまうため。
  const inclineHeights = new Map<string, number>();
  for (let x = -3; x <= 3; x++) {
    inclineHeights.set(toKey(x, 0), 1);
    inclineHeights.set(toKey(x, 1), 1);
  }
  const inclineTerrain = fieldFromMaps(inclineHeights, new Map(), 45);
  const mountainCosmeticTerrain = fieldFromMaps(new Map(), new Map<string, 'water' | 'mountain'>([['0,0', 'mountain']]), 45);

  it('水域セルへの駅設置は no-op（stateの参照が変わらない）', () => {
    const state = emptyState();
    const result = applyStation(state, { x: 0, z: 0 }, waterTerrain);
    expect(result).toBe(state);
    expect(result.railMap.has(toKey(0, 0))).toBe(false);
  });

  it('傾斜(incline)セルへの駅設置は no-op(平坦セルにしか置けない)', () => {
    const state = emptyState();
    const result = applyStation(state, { x: 0, z: 0 }, inclineTerrain);
    expect(result).toBe(state);
  });

  it('表示上mountain分類なだけで実際は平坦(4隅とも標高0)なセルには駅を設置できる(mountain概念の廃止)', () => {
    const state = emptyState();
    const result = applyStation(state, { x: 0, z: 0 }, mountainCosmeticTerrain);
    expect(result.railMap.get(toKey(0, 0))!.type).toBe('station');
  });

  it('水域セルへの車庫設置は no-op', () => {
    const state = emptyState();
    const result = applyDepot(state, { x: 0, z: 0 }, waterTerrain);
    expect(result).toBe(state);
    expect(result.railMap.has(toKey(0, 0))).toBe(false);
  });

  it('傾斜(incline)セルへの車庫設置は no-op', () => {
    const state = emptyState();
    const result = applyDepot(state, { x: 0, z: 0 }, inclineTerrain);
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

  it('表示上mountain分類なだけで実際は平坦(4隅とも標高0)なセルには、tunnelを付けず普通の線路として敷設できる(mountain概念の廃止)', () => {
    const state = emptyState();
    const result = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }], mountainCosmeticTerrain);
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.type).toBe('rail');
    expect(cell.tunnel).toBeUndefined();
  });
});

describe('P7b: 標高に応じた地上線路建設(勾配追従/トンネル/不可)', () => {
  // 3x3の山塊(x:0..2, z:0..2、それ以外は既定でgrass)。境界セルは標高1、中心(1,1)は
  // マンハッタン距離2で標高2になる(computeElevationのテストと同じ形)。min則コーナー
  // 導出では、この形は「東西の縁がinclineで登り、中心が標高1のflat」という滑らかな
  // 丘になる(実際に4隅を計算し確認済み。旧・fringe/内部判定の概念はP7bで廃止)。
  const makeBlockTerrain = () => {
    const terrain = new Map<string, TerrainType>();
    for (let x = 0; x <= 2; x++) {
      for (let z = 0; z <= 2; z++) {
        terrain.set(toKey(x, z), 'mountain');
      }
    }
    return fieldFromMaps(computeElevation(terrain), terrain, 45);
  };

  // 幅1セルの尾根(x軸方向、z=0の1行だけ)。南北(z=-1/z=1)は非mountainのため、
  // min則コーナー導出では隣接セルに引っ張られて4隅とも標高0に潰れる(=実体の無い、
  // 完全に平坦な「見た目だけmountain」のセルになる)。
  const makeRidgeTerrain = () => {
    const terrain = new Map<string, TerrainType>();
    for (let x = -2; x <= 2; x++) {
      terrain.set(toKey(x, 0), 'mountain');
    }
    return fieldFromMaps(computeElevation(terrain), terrain, 45);
  };

  it('3x3山塊を貫く直線は、なだらかな丘として勾配追従で建設できる(tunnelにならない)', () => {
    const terrain = makeBlockTerrain();
    const state = emptyState();
    const result = applyRailPath(state, [{ x: 0, z: 1 }, { x: 1, z: 1 }, { x: 2, z: 1 }], terrain);

    // 1セル1段の傾斜(incline)で登って降りられる形状なので、トンネルは不要。
    expect(result.railMap.get(toKey(0, 1))?.type).toBe('rail');
    expect(result.railMap.get(toKey(1, 1))?.type).toBe('rail');
    expect(result.railMap.get(toKey(1, 1))?.tunnel).toBeUndefined();
    expect(result.railMap.get(toKey(2, 1))?.tunnel).toBeUndefined();
  });

  it('幅1の尾根(実際には完全に平坦)は、mountain分類に関わらず普通に建設できる(mountain概念の廃止)', () => {
    const terrain = makeRidgeTerrain();
    const state = emptyState();
    const result = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }], terrain);

    expect(result.railMap.get(toKey(0, 0))?.type).toBe('rail');
    expect(result.railMap.get(toKey(0, 0))?.tunnel).toBeUndefined();
  });

  // 実際の地形(隣接セル間でコーナー標高が共有される)では、勾配追従が破綻するのは
  // 「1段より急な段差」や「1段登った先がすぐ2段目になる」ような形状に限られる。
  // TerrainFieldを直接実装するテストダブルで、そのような形状(otherスロープ)を作る。
  const otherSlopeField = (
    cornersByCell: Record<string, [number, number, number, number]>
  ): TerrainField => {
    const key = (x: number, z: number) => `${x},${z}`;
    const cellCornerHeights = (x: number, z: number) => cornersByCell[key(x, z)] ?? [0, 0, 0, 0];
    return {
      cornerHeightAt: () => 0,
      cellCornerHeights,
      cellHeightAt: (x, z) => Math.min(...cellCornerHeights(x, z)),
      terrainTypeAt: (x, z) => (Math.min(...cellCornerHeights(x, z)) >= 1 ? 'mountain' : 'grass'),
    };
  };

  it('勾配追従できない区間は、進入標高を保った定高さのtunnelとして建設できる', () => {
    // x=-1: 平地(標高0)。x=0,1: otherスロープ(標高1だが4隅が不揃いでinclineにならない)。
    // x=2: 平地(標高0、tunnelの出口として標高が一致)。
    const field = otherSlopeField({
      '0,0': [2, 2, 2, 1],
      '1,0': [2, 1, 1, 2],
    });
    const state = emptyState();
    const result = applyRailPath(
      state,
      [{ x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }],
      field
    );

    expect(result.railMap.get(toKey(-1, 0))?.tunnel).toBeUndefined();
    expect(result.railMap.get(toKey(0, 0))?.tunnel).toEqual({ height: 0 });
    expect(result.railMap.get(toKey(1, 0))?.tunnel).toEqual({ height: 0 });
    expect(result.railMap.get(toKey(2, 0))?.tunnel).toBeUndefined();
  });

  it('トンネル区間の出口の標高が進入標高と一致しない場合は経路全体が建設不可(no-op)', () => {
    // 出口セル(2,0)を標高1のflatにする(進入標高0と食い違う)。
    const field = otherSlopeField({
      '0,0': [2, 2, 2, 1],
      '1,0': [2, 1, 1, 2],
      '2,0': [1, 1, 1, 1],
    });
    const state = emptyState();
    const result = applyRailPath(
      state,
      [{ x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }],
      field
    );

    expect(result.railMap).toBe(state.railMap);
  });

  it('otherスロープの地形が進入標高より高くない場合は建設不可(トンネルにできない)', () => {
    // 進入セル(-1,0)は標高2のflat。(0,0)はotherスロープだが最大コーナーが2(=進入標高と
    // 同じ)なので「地形が高い」とは言えず、トンネル候補にならない。
    const field = otherSlopeField({
      '-1,0': [2, 2, 2, 2],
      '0,0': [2, 2, 1, 2],
      '1,0': [2, 2, 2, 2],
    });
    const state = emptyState();
    const result = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }], field);

    expect(result.railMap).toBe(state.railMap);
  });
});

describe('P7d: resolveGroundRailPlanDetailed（建設不可の理由、UIフィードバック向け）', () => {
  const otherSlopeField = (
    cornersByCell: Record<string, [number, number, number, number]>
  ): TerrainField => {
    const key = (x: number, z: number) => `${x},${z}`;
    const cellCornerHeights = (x: number, z: number) => cornersByCell[key(x, z)] ?? [0, 0, 0, 0];
    return {
      cornerHeightAt: () => 0,
      cellCornerHeights,
      cellHeightAt: (x, z) => Math.min(...cellCornerHeights(x, z)),
      terrainTypeAt: (x, z) => (Math.min(...cellCornerHeights(x, z)) >= 1 ? 'mountain' : 'grass'),
    };
  };

  it('建設できる経路はreasonを持たずplanを返す', () => {
    const field = fieldFromMaps(new Map(), new Map(), 45);
    const result = resolveGroundRailPlanDetailed(field, [{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    expect(result.reason).toBeUndefined();
    expect(result.plan).not.toBeNull();
  });

  it('otherスロープの地形が進入標高より高くない場合はreason:other-slope', () => {
    const field = otherSlopeField({
      '-1,0': [2, 2, 2, 2],
      '0,0': [2, 2, 1, 2],
      '1,0': [2, 2, 2, 2],
    });
    const result = resolveGroundRailPlanDetailed(field, [{ x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }]);
    expect(result.plan).toBeNull();
    expect(result.reason).toBe('other-slope');
  });

  it('トンネル区間の出口標高が進入標高と食い違う場合はreason:tunnel-exit-mismatch', () => {
    const field = otherSlopeField({
      '0,0': [2, 2, 2, 1],
      '1,0': [2, 1, 1, 2],
      '2,0': [1, 1, 1, 1],
    });
    const result = resolveGroundRailPlanDetailed(
      field,
      [{ x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }]
    );
    expect(result.plan).toBeNull();
    expect(result.reason).toBe('tunnel-exit-mismatch');
  });

  it('inclineの許可方向以外へ接続しようとするとreason:direction-blocked', () => {
    // (0,0)はN-Sのincline(nw=ne=1, sw=se=0)。東西(E-W)方向の経路は許可されない。
    // 隣接セルは同じ標高スケール(flat 1)にして、edge-discontinuousが同時に出ないようにする。
    const field = otherSlopeField({
      '-1,0': [1, 1, 1, 1],
      '0,0': [1, 1, 0, 0],
    });
    const result = resolveGroundRailPlanDetailed(field, [{ x: -1, z: 0 }, { x: 0, z: 0 }]);
    expect(result.plan).toBeNull();
    expect(result.reason).toBe('direction-blocked');
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

// P8a: pickElevatedConnection/planElevatedPathは高架(正)と地下(負)を符号対称に
// 扱えることを要求される(progress/underground-design.md「レベル一般化」)。
// 正レベルの入力を全部符号反転しても、返り値のlevel/baseだけ符号反転して一致するはず。
describe('pickElevatedConnection/planElevatedPath の符号対称性(P8a: 地下レベルへの一般化)', () => {
  it('pickElevatedConnection: 正レベルの結果を符号反転すると負レベルの結果と一致する', () => {
    const cases: Array<{ levels: number[]; level: number }> = [
      { levels: [0, 2], level: 2 },
      { levels: [0, 1], level: 3 },
      { levels: [0], level: 2 },
      { levels: [], level: 2 },
      { levels: [3], level: 1 },
      { levels: [2], level: 0 },
      { levels: [1, 3], level: 0 },
      { levels: [], level: 0 },
      { levels: [0], level: 0 },
    ];
    for (const c of cases) {
      const positive = pickElevatedConnection({ levels: c.levels }, c.level as BuildLevel);
      const negative = pickElevatedConnection(
        { levels: c.levels.map(l => -l) },
        -c.level as BuildLevel
      );
      if (positive.kind === 'connect') {
        expect(negative).toEqual({ kind: 'connect', level: -positive.level });
      } else {
        expect(negative).toEqual(positive);
      }
    }
  });

  it('planElevatedPath: 正レベルの計画を符号反転しても、null/non-nullとセル数(rampCount内訳)は一致する', () => {
    // 注意: M(接続先の既存レベル)とlevel(建設レベル)の大小関係(M<level vs M>level)は
    // 符号反転で反転する(例: 1<2 だが -1>-2)ため、ramp内のnear/far(local level 1/2)の
    // 割り当てやbaseの実際の値は単純な符号反転にはならない(2つ上のit「アンカー無し」/
    // 「アンカー」で個別に正しい値を検証済み)。ここでは符号に関わらず不変であるべき
    // 「経路が成立するか」と「各roleの種別ごとの個数」だけを対称性として検証する。
    const cont: ElevatedEndPlan = { kind: 'continue' };
    const flat: ElevatedEndPlan = { kind: 'flat' };
    const negate = (e: ElevatedEndPlan): ElevatedEndPlan => (e.kind === 'connect' ? { kind: 'connect', level: -e.level } : e);
    const cases: Array<{ length: number; start: ElevatedEndPlan; end: ElevatedEndPlan; level: number }> = [
      { length: 6, start: flat, end: flat, level: 1 },
      { length: 4, start: { kind: 'connect', level: 1 }, end: flat, level: 2 },
      { length: 3, start: cont, end: cont, level: 1 },
      { length: 10, start: { kind: 'connect', level: 1 }, end: flat, level: 3 },
    ];
    const counts = (roles: ElevatedPathPlan['roles']) => ({
      ramp: roles.filter(r => r.kind === 'ramp').length,
      anchor: roles.filter(r => r.kind === 'anchor').length,
      span: roles.filter(r => r.kind === 'span').length,
    });
    for (const c of cases) {
      const positive = planElevatedPath(c.length, c.start, c.end, c.level as BuildLevel);
      const negative = planElevatedPath(c.length, negate(c.start), negate(c.end), -c.level as BuildLevel);
      expect(positive === null).toBe(negative === null);
      if (!positive || !negative) continue;
      expect(counts(negative.roles)).toEqual(counts(positive.roles));
    }
  });

  it('地平(0)から地下(-1)へ潜る掘割は、地平(0)から高架(1)へ登る坂と対称に「アンカー無し」になる(地平タイル自身が坂の一部を兼ねる)', () => {
    // 地平タイルが「登る先の既存構造」になるのは level===0 かつ M!==0 のときだけ
    // (M自身が高架/地下いずれの向きでも常にアンカー)。地平(0)からM(既存)へ向かって
    // 新規に潜る/登るこの向きは逆(0は「新規に建設する側」)なので、正負どちらも
    // アンカー無しで対称になる。
    const planUp = planElevatedPath(4, { kind: 'connect', level: 0 }, { kind: 'flat' }, 1);
    const planDown = planElevatedPath(4, { kind: 'connect', level: 0 }, { kind: 'flat' }, -1);
    expect(planUp!.roles.map(r => r.kind)).toEqual(['ramp', 'ramp', 'span', 'span']);
    expect(planDown!.roles.map(r => r.kind)).toEqual(['ramp', 'ramp', 'span', 'span']);
    expect(planUp!.roles[0]).toEqual({ kind: 'ramp', side: 'start', base: 0, level: 1 });
    expect(planUp!.roles[1]).toEqual({ kind: 'ramp', side: 'start', base: 0, level: 2 });
    expect(planDown!.roles[0]).toEqual({ kind: 'ramp', side: 'start', base: -1, level: 2 });
    expect(planDown!.roles[1]).toEqual({ kind: 'ramp', side: 'start', base: -1, level: 1 });
  });

  it('既存の高架(M=2)へ地平(level=0)から登る場合はアンカー(従来通り)、既存の地下(M=-2)へ地平から潜る場合もアンカー(対称)', () => {
    const planUp = planElevatedPath(6, { kind: 'connect', level: 2 }, { kind: 'flat' }, 0);
    const planDown = planElevatedPath(6, { kind: 'connect', level: -2 }, { kind: 'flat' }, 0);
    expect(planUp!.roles[0]).toEqual({ kind: 'anchor', side: 'start', connectLevel: 2 });
    expect(planDown!.roles[0]).toEqual({ kind: 'anchor', side: 'start', connectLevel: -2 });
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
    const terrain = fieldFromMaps(new Map(), new Map<string, TerrainType>([[toKey(0, 0), 'water']]), 45);
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

  it('P7b: 坂になるセルが平坦でも標高1以上(flatな高原)の場合はno-op(坂は標高0の地平専用)', () => {
    // isBuildableGroundはP7bで「flatなら任意標高で可」に緩んだが、坂(ramp)は従来通り
    // 標高0限定のガード(isFlatGroundLevelZero)を通す。applyBridge(旧・固定長橋)は
    // 両端2セルずつを強制的に地平(level0)接続の坂にするため、この検証に使える。
    const field: TerrainField = {
      cornerHeightAt: () => 1,
      cellCornerHeights: () => [1, 1, 1, 1],
      cellHeightAt: () => 1,
      terrainTypeAt: () => 'mountain',
    };
    const state = emptyState();
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const result = applyBridge(state, path, field);
    expect(result).toBe(state);
  });

  it('水域の上にも高架線を敷ける(橋の役割を兼ねる)', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: -1, z: 0 }, { x: 0, z: 0 }]);
    const terrain = fieldFromMaps(new Map(), new Map<string, TerrainType>([[toKey(2, 0), 'water']]), 45);
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

describe('地下線(applyUndergroundPath, P8a)', () => {
  const flatField = fieldFromMaps(new Map(), new Map(), 45);

  it('両端とも浮いた地下線を敷ける(uppers[-1]にconnectionsが立つ)', () => {
    let state = emptyState();
    state = applyUndergroundPath(state, [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
    ], flatField, -1);
    for (const x of [0, 1, 2]) {
      expect(state.railMap.get(toKey(x, 0))?.uppers?.[-1]?.connections).toBeGreaterThan(0);
    }
  });

  it('地平の既存線路と同じセルに共存できる(地平のconnectionsを一切変更しない、overpassと同じ発想)', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }]);
    const groundBefore = state.railMap.get(toKey(1, 0))!.connections;
    state = applyUndergroundPath(state, [
      { x: 1, z: -1 }, { x: 1, z: 0 }, { x: 1, z: 1 },
    ], flatField, -1);
    const cell = state.railMap.get(toKey(1, 0))!;
    expect(cell.connections).toBe(groundBefore); // 地平の線路はそのまま
    expect(cell.uppers?.[-1]?.connections).toBeGreaterThan(0); // 地下線も併存
  });

  it('水域のセルを経路が通るとno-op', () => {
    const state = emptyState();
    const waterField = fieldFromMaps(new Map(), new Map<string, TerrainType>([[toKey(1, 0), 'water']]), 45);
    const result = applyUndergroundPath(state, [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
    ], waterField, -1);
    expect(result).toBe(state);
  });

  it('地表がinclineなセルを経路が通るとno-op(地下はflatな地表の下にしか通せない)', () => {
    const state = emptyState();
    // z=0行をincline(z=-1側は標高0、z=1側は標高1)にする(construction.test.ts冒頭の
    // 「地形による建設制約」describeのinclineTerrainと同じ作り方)。
    const inclineHeights = new Map<string, number>();
    for (let x = -3; x <= 3; x++) {
      inclineHeights.set(toKey(x, 0), 1);
      inclineHeights.set(toKey(x, 1), 1);
    }
    const inclineField = fieldFromMaps(inclineHeights, new Map(), 45);
    const result = applyUndergroundPath(state, [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
    ], inclineField, -1);
    expect(result).toBe(state);
  });

  it('地平の自由端からapplyUndergroundPathで直接繋ぐと、地平タイル自身が掘割ランプの一部になる(アンカー無し)', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }]);
    state = applyUndergroundPath(state, [
      { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ], flatField, -1);
    const groundCell = state.railMap.get(toKey(2, 0))!;
    expect(groundCell.ramp).toBeDefined();
    expect(groundCell.ramp!.base).toBe(-1);
    // pathfinding(resolveEntryLayer)は「今いる層」のconnections/uppersしか見ないため、
    // 地平から掘割ランプへ進めるにはbase===-1のランプセルがconnections側にも
    // 同じビットを持つ必要がある(base===0の場合にorIntoBaseLevelがconnectionsへ
    // 書くのと対称の理由)。ramp.base自体は-1のまま変わらない。
    expect(groundCell.connections).toBeGreaterThan(0);
  });
});

describe('地下駅(applyUndergroundStation, P8a)', () => {
  const flatField = fieldFromMaps(new Map(), new Map(), 45);

  it('地下線が無いセルへは置けない(no-op)', () => {
    const state = emptyState();
    const result = applyUndergroundStation(state, { x: 0, z: 0 });
    expect(result).toBe(state);
  });

  it('地下線セルに置くと、そのセルがuppers[-1].stationIdを持つ新しい地下駅になる', () => {
    let state = emptyState();
    state = applyUndergroundPath(state, [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ], flatField, -1);
    const result = applyUndergroundStation(state, { x: 2, z: 0 });
    const cell = result.railMap.get(toKey(2, 0))!;
    expect(cell.uppers?.[-1]?.stationId).toBeDefined();
  });

  it('同じ(x,z)の地平駅と統合され、乗換駅(地上+地下)になる', () => {
    let state = emptyState();
    state = applyStation(state, { x: 2, z: 0 }, undefined, [], 'ns');
    const groundStationId = state.railMap.get(toKey(2, 0))!.stationId!;
    state = applyUndergroundPath(state, [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ], flatField, -1);
    const result = applyUndergroundStation(state, { x: 2, z: 0 });
    const cell = result.railMap.get(toKey(2, 0))!;
    expect(cell.stationId).toBe(groundStationId);
    expect(cell.uppers?.[-1]?.stationId).toBe(groundStationId);
    const st = result.stations.get(groundStationId)!;
    expect(st.cells).toEqual(
      expect.arrayContaining([{ x: 2, z: 0 }, { x: 2, z: 0, layer: -1 }])
    );
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

  it('planElevatedPath: level=0でconnect(level:2)の端には、アンカー(既存桁そのもの)+坂4セル(base1→base0の降順)が割り当てられる', () => {
    const plan = planElevatedPath(6, { kind: 'flat' }, { kind: 'connect', level: 2 }, 0);
    expect(plan).not.toBeNull();
    // アンカー(既存レベル2の端タイルそのもの)は坂ではない専用roleになり、坂に数えない。
    expect(plan!.roles.map(r => r.kind)).toEqual(['span', 'ramp', 'ramp', 'ramp', 'ramp', 'anchor']);
    // 接続先(既存レベル2、アンカーはindex5)に近い側から: base1(level2側)→base0(地平側)の順に降りる
    expect(plan!.roles[1]).toEqual({ kind: 'ramp', side: 'end', base: 0, level: 1 });
    expect(plan!.roles[2]).toEqual({ kind: 'ramp', side: 'end', base: 0, level: 2 });
    expect(plan!.roles[3]).toEqual({ kind: 'ramp', side: 'end', base: 1, level: 1 });
    expect(plan!.roles[4]).toEqual({ kind: 'ramp', side: 'end', base: 1, level: 2 });
    expect(plan!.roles[5]).toEqual({ kind: 'anchor', side: 'end', connectLevel: 2 });
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

  it('端を浮いた高架(レベル1)の端タイルに当てると、坂2セル+アンカー(ramp無し)で自動接続される(不具合再現: 桁セルにrampが同居しない)', () => {
    let state = emptyState();
    // レベル1の浮いた高架(両端とも接続先なし)を(4,0)〜(9,0)に敷く
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, 1);
    expect(state.railMap.get(toKey(4, 0))!.uppers?.[1]?.connections).toBeGreaterThan(0);

    // 地平の線路を(0,0)から高架の端タイル(4,0)まで引く
    const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const result = applyRailPath(state, path);

    // 接続先(4,0)に近い2セル(2,0)(3,0)が坂になり、遠い側(0,0)(1,0)は平坦な地平線路のまま。
    // アンカー(4,0)は既存の桁セルそのものなので坂(ramp)にはならない
    // (桁+坂の二重描画を防ぐため。これが不具合の根本原因だった)。
    expect(result.railMap.get(toKey(0, 0))!.ramp).toBeUndefined();
    expect(result.railMap.get(toKey(1, 0))!.ramp).toBeUndefined();
    expect(result.railMap.get(toKey(2, 0))!.ramp).toBeDefined();
    expect(result.railMap.get(toKey(3, 0))!.ramp).toBeDefined();
    expect(result.railMap.get(toKey(4, 0))!.ramp).toBeUndefined();

    // アンカーセル(4,0)は既存のuppers[1]がそのまま残りつつ、新しい方向(西=坂側)のビットが追加される
    const anchor = result.railMap.get(toKey(4, 0))!;
    expect(anchor.uppers?.[1]?.connections).toBeDefined();
    expect((anchor.uppers![1]!.connections & DIR.W)).toBe(DIR.W);
    // 既存の桁の東方向の接続(高架内部)は保持されたまま
    expect((anchor.uppers![1]!.connections & DIR.E)).toBe(DIR.E);

    // ramp.dirは「登る方向(高い側=アンカーのある側)」を指す規約(buildRampTrackParts参照)。
    // アンカー(4,0)は坂セルより東(+x)にあるので、両方の坂セルのdirは東(DIR.E)でなければならない。
    // (西を指すと傾斜が逆向きに描画され、宙に浮いた破片になる不具合があった)
    expect(result.railMap.get(toKey(2, 0))!.ramp!.dir).toBe(DIR.E);
    expect(result.railMap.get(toKey(3, 0))!.ramp!.dir).toBe(DIR.E);
  });

  it('経路のstart側(index0)がアンカーの場合も、ramp.dirはアンカーのある向きを指す', () => {
    let state = emptyState();
    // レベル1の浮いた高架を(10,0)〜(15,0)に敷く
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 10, z: 0 })), undefined, 1);
    // アンカー(10,0)を始点(index0)にして、西へ向かう地平の線路を引く
    const path = [{ x: 10, z: 0 }, { x: 9, z: 0 }, { x: 8, z: 0 }, { x: 7, z: 0 }, { x: 6, z: 0 }];
    const result = applyRailPath(state, path);

    expect(result.railMap.get(toKey(10, 0))!.ramp).toBeUndefined();
    expect(result.railMap.get(toKey(9, 0))!.ramp).toBeDefined();
    expect(result.railMap.get(toKey(8, 0))!.ramp).toBeDefined();
    expect(result.railMap.get(toKey(7, 0))!.ramp).toBeUndefined();

    // アンカー(10,0)は坂セルより東(+x)にあるので、dirは東(DIR.E)を指す
    expect(result.railMap.get(toKey(9, 0))!.ramp!.dir).toBe(DIR.E);
    expect(result.railMap.get(toKey(8, 0))!.ramp!.dir).toBe(DIR.E);
  });

  it('端を浮いた高架(レベル2)の端タイルに当てると、坂4セル+アンカー(ramp無し)で接続される', () => {
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
    expect(anchor.ramp).toBeUndefined();
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
    const terrain = fieldFromMaps(new Map(), new Map<string, TerrainType>([[toKey(3, 0), 'water']]), 45);
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
    expect(result.railMap.get(toKey(2, -2))!.ramp).toBeDefined();
    expect(result.railMap.get(toKey(3, -3))!.ramp).toBeDefined();
    // アンカー(4,-4)は既存の桁そのものなので坂にはならない
    expect(result.railMap.get(toKey(4, -4))!.ramp).toBeUndefined();
    expect((result.railMap.get(toKey(4, -4))!.uppers![1]!.connections & DIR.SW)).toBe(DIR.SW);
    // アンカー(4,-4)は坂セルよりNE方向にあるので、dirはNEを指す
    expect(result.railMap.get(toKey(2, -2))!.ramp!.dir).toBe(DIR.NE);
    expect(result.railMap.get(toKey(3, -3))!.ramp!.dir).toBe(DIR.NE);
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

describe('applyStation: 坂(ramp)セルへの設置', () => {
  it('坂セルへの駅設置はno-op(同一state参照を返す)', () => {
    // applyBridgeで両端2セルずつが坂になる橋を作る(0,1が始点側の坂)
    let state = emptyState();
    state = applyBridge(state, Array.from({ length: 6 }, (_, i) => ({ x: i, z: 0 })));
    const rampCell = state.railMap.get(toKey(1, 0))!;
    expect(rampCell.ramp).toBeDefined();

    // 坂セルは直線専用(斜面)なので駅ホームは置けない。stateを一切変えず
    // 同一参照を返す(buildPreview側はこの「無効果」で建設不可と判定する)。
    const result = applyStation(state, { x: 1, z: 0 });
    expect(result).toBe(state);
    // 軸を明示しても同じ
    expect(applyStation(state, { x: 1, z: 0 }, undefined, [], 'ns')).toBe(state);
  });
});

describe('removePath: uppersの後始末({1: undefined}を残さない)', () => {
  it('隣の桁の撤去でuppersが空になったセルは、uppers自体がundefinedになる', () => {
    let state = emptyState();
    state = applyElevatedPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }], undefined, 1);
    const result = removePath(state, [{ x: 1, z: 0 }]);
    // (0,0)のuppers[1].connectionsはEだけだったので空になる。
    // {1: undefined}(truthyな空オブジェクト)を残すと、次の撤去が高架撤去の
    // 分岐へ誤って入り、セルが消えない・隣の掃除が走らないバグになる。
    expect(result.railMap.get(toKey(0, 0))!.uppers).toBeUndefined();
  });

  it('uppersが空になった地平セルは、その後の撤去でセル削除と隣接の掃除が正しく行われる', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(-1, 0), { type: 'rail', connections: DIR.E });
    railMap.set(toKey(0, 0), { type: 'rail', connections: DIR.W, uppers: { 1: { connections: DIR.E } } });
    railMap.set(toKey(1, 0), { type: 'rail', uppers: { 1: { connections: DIR.W } } });
    const state: ConstructionState = { railMap, stations: new Map<string, StationData>() };

    const after1 = removePath(state, [{ x: 1, z: 0 }]);
    expect(after1.railMap.get(toKey(0, 0))!.uppers).toBeUndefined();

    // 続けて(0,0)を撤去: セル自体が消え、(-1,0)のE接続も掃除される
    const after2 = removePath(after1, [{ x: 0, z: 0 }]);
    expect(after2.railMap.has(toKey(0, 0))).toBe(false);
    expect(after2.railMap.get(toKey(-1, 0))!.connections! & DIR.E).toBe(0);
  });
});

describe('removePath: 高架撤去に伴う坂と地平接続の掃除', () => {
  it('純高架セルの撤去で、隣の坂セルの地平接続ビットも掃除される', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(0, 0), { type: 'rail', connections: DIR.E });
    railMap.set(toKey(1, 0), { type: 'rail', connections: DIR.E | DIR.W, ramp: { dir: DIR.E, level: 2, base: 0 } });
    railMap.set(toKey(2, 0), { type: 'rail', uppers: { 1: { connections: DIR.W } } });
    const state: ConstructionState = { railMap, stations: new Map<string, StationData>() };

    const result = removePath(state, [{ x: 2, z: 0 }]);
    const rampCell = result.railMap.get(toKey(1, 0))!;
    // 存在しないセルへ向かう平坦なレールの腕(E)が宙に残らない
    expect(rampCell.connections).toBe(DIR.W);
    // 行き先を失った坂は平坦へ戻る
    expect(rampCell.ramp).toBeUndefined();
  });

  it('2段の坂は撤去セルの8近傍を超えて連鎖的に地平へ戻る', () => {
    let state = emptyState();
    const path = Array.from({ length: 6 }, (_, i) => ({ x: i, z: 0 }));
    // 0:base0/lv1, 1:base0/lv2, 2:base1/lv1, 3:base1/lv2, 4-5: uppers[2]の桁
    state = applyElevatedPath(state, path, undefined, 2, {
      start: { kind: 'connect', level: 0 },
      end: { kind: 'flat' },
    });
    expect(state.railMap.get(toKey(2, 0))!.ramp).toBeDefined();
    expect(state.railMap.get(toKey(3, 0))!.ramp).toBeDefined();

    const result = removePath(state, [{ x: 5, z: 0 }, { x: 4, z: 0 }]);
    // (3,0)は行き先の桁が消えたので戻る。(2,0)は(3,0)の坂が消えたので連鎖して戻る
    // ((4,0)の8近傍の外にあるため、従来の実装では坂の半分が宙に浮いたまま残った)。
    expect(result.railMap.get(toKey(3, 0))!.ramp).toBeUndefined();
    expect(result.railMap.get(toKey(2, 0))!.ramp).toBeUndefined();
    // base0の坂は登り先のレベル1線路(uppers[1])が残っている限り維持される
    expect(result.railMap.get(toKey(1, 0))!.ramp).toBeDefined();
  });
});

describe('applyRailPath: PM2 軌間(railOptions)', () => {
  it('railOptions省略時は従来どおりgauge/electrifiedを持たないセルが敷かれる', () => {
    const state = emptyState();
    const result = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    expect(result.railMap.get(toKey(0, 0))!.gauge).toBeUndefined();
    expect(result.railMap.get(toKey(0, 0))!.electrified).toBeUndefined();
  });

  it('railOptionsで指定した軌間・電化がセルに記録される', () => {
    const state = emptyState();
    const result = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }], undefined, undefined, { gauge: 1435, electrified: true });
    expect(result.railMap.get(toKey(0, 0))!.gauge).toBe(1435);
    expect(result.railMap.get(toKey(0, 0))!.electrified).toBe(true);
    expect(result.railMap.get(toKey(1, 0))!.gauge).toBe(1435);
  });

  it('既存の異なる軌間のセルへは接続ビットを立てない(その隣接方向には繋がらない)', () => {
    let state = emptyState();
    // まず狭軌の単独セルを敷く
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: -1, z: 0 }], undefined, undefined, { gauge: 1067 });
    // 標準軌の経路を(0,0)へ隣接させて延ばそうとする
    const result = applyRailPath(state, [{ x: 1, z: 0 }, { x: 0, z: 0 }], undefined, undefined, { gauge: 1435 });
    const originCell = result.railMap.get(toKey(0, 0))!;
    // (0,0)は既に狭軌として存在するため軌間は変わらず、標準軌側(1,0)からの接続(東向き)は立たない
    expect(originCell.gauge).toBe(1067);
    expect(originCell.connections! & DIR.E).toBe(0);
    // 一方、標準軌側の新規セル(1,0)自体は敷設される
    expect(result.railMap.get(toKey(1, 0))!.gauge).toBe(1435);
  });

  it('同一軌間同士は従来どおり接続される', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: -1, z: 0 }], undefined, undefined, { gauge: 1067 });
    const result = applyRailPath(state, [{ x: 1, z: 0 }, { x: 0, z: 0 }], undefined, undefined, { gauge: 1067 });
    const originCell = result.railMap.get(toKey(0, 0))!;
    expect(originCell.connections! & DIR.E).toBe(DIR.E);
  });
});
