import { describe, it, expect } from 'vitest';
import type { CellData, TerrainType, TownData } from '../types';
import { toKey, fromKey } from '../utils';
import {
  generateTownSubTiles,
  generateTownTiles,
  deriveTileKinds,
  buildTownIndexes,
  buildTownTileIndex,
  isTownBlocked,
  townTileAt,
  townTileRadius,
  townSubTileRadius,
  townHouseTarget,
  cellOccupiesGround,
  parentTileOfSub,
  subTileWorldCentre,
  TOWN_TILE_RADIUS_MAX,
  TOWN_SUB_TILE_RADIUS_MAX,
  TOWN_ROAD_PRUNE_DISTANCE,
} from './townTiles';
import {
  applyRailPath,
  applyRailPathDetailed,
  applyElevatedPath,
  applyStation,
  applyDepot,
  applySignal,
  type ConstructionState,
} from './construction';
import { DIR } from '../utils';

const town = (id: string, x: number, z: number, population: number): TownData => ({
  id,
  name: `${id}町`,
  centre: { x, z },
  population,
});

const emptyTerrain = new Map<string, TerrainType>();

describe('townTiles: サブタイル座標', () => {
  it('parentTileOfSubは負のサブ座標も正しく親タイルへ写す', () => {
    expect(parentTileOfSub(0)).toBe(0);
    expect(parentTileOfSub(1)).toBe(0);
    expect(parentTileOfSub(2)).toBe(1);
    expect(parentTileOfSub(-1)).toBe(-1);
    expect(parentTileOfSub(-2)).toBe(-1);
    expect(parentTileOfSub(-3)).toBe(-2);
  });

  it('subTileWorldCentreはタイル(x±0.5)内の4分割中央に来る', () => {
    // タイル0のサブタイル(0,1)は -0.25 / +0.25
    expect(subTileWorldCentre(0)).toBeCloseTo(-0.25);
    expect(subTileWorldCentre(1)).toBeCloseTo(0.25);
    // タイル-1のサブタイル(-2,-1)は -1.25 / -0.75
    expect(subTileWorldCentre(-2)).toBeCloseTo(-1.25);
    expect(subTileWorldCentre(-1)).toBeCloseTo(-0.75);
  });
});

describe('townTiles: サブタイル生成', () => {
  it('同じ入力からは常に同じサブタイル配置になる(決定的)', () => {
    const t = town('town-0', 5, -3, 2400);
    const a = generateTownSubTiles(t, emptyTerrain);
    const b = generateTownSubTiles(t, emptyTerrain);
    expect(a.size).toBeGreaterThan(0);
    expect(Array.from(a.entries()).sort()).toEqual(Array.from(b.entries()).sort());
  });

  it('中心サブタイルは道路になり、全道路サブタイルは中心から4近傍で辿れる', () => {
    const t = town('town-1', 0, 0, 6000);
    const subs = generateTownSubTiles(t, emptyTerrain);
    expect(subs.get(toKey(0, 0))).toBe('road');

    const roads = new Set(
      Array.from(subs.entries()).filter(([, k]) => k === 'road').map(([key]) => key)
    );
    // BFSで中心から到達できる道路サブタイルを数える
    const reached = new Set<string>([toKey(0, 0)]);
    const queue = [{ x: 0, z: 0 }];
    while (queue.length > 0) {
      const p = queue.shift()!;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const key = toKey(p.x + dx, p.z + dz);
        if (reached.has(key) || !roads.has(key)) continue;
        reached.add(key);
        queue.push({ x: p.x + dx, z: p.z + dz });
      }
    }
    expect(reached.size).toBe(roads.size);
  });

  it('家は必ず道路サブタイルに4近傍で隣接する', () => {
    const t = town('town-2', 0, 0, 4000);
    const subs = generateTownSubTiles(t, emptyTerrain);
    const houses = Array.from(subs.entries()).filter(([, k]) => k === 'house');
    expect(houses.length).toBeGreaterThan(0);
    for (const [key] of houses) {
      const { x, z } = fromKey(key);
      const adjacent = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(
        ([dx, dz]) => subs.get(toKey(x + dx, z + dz)) === 'road'
      );
      expect(adjacent).toBe(true);
    }
  });

  it('水域・山岳・標高1以上の親タイルにはサブタイルを置かない', () => {
    const terrain = new Map<string, TerrainType>();
    const heights = new Map<string, number>();
    // 中心の東側を水域、西側を山岳(標高1)にする(親タイル単位)
    for (let z = -16; z <= 16; z++) {
      terrain.set(toKey(2, z), 'water');
      terrain.set(toKey(-2, z), 'mountain');
      heights.set(toKey(-2, z), 1);
    }
    const t = town('town-3', 0, 0, 8000);
    const subs = generateTownSubTiles(t, terrain, heights);
    for (const key of subs.keys()) {
      const px = parentTileOfSub(fromKey(key).x);
      expect(px).not.toBe(2);
      expect(px).not.toBe(-2);
    }
  });

  it('人口が多いほど半径・家の数が増える(視覚的に成長する)', () => {
    expect(townTileRadius(500)).toBeLessThan(townTileRadius(20000));
    expect(townTileRadius(10 ** 9)).toBe(TOWN_TILE_RADIUS_MAX);
    expect(townSubTileRadius(500)).toBeLessThan(townSubTileRadius(20000));
    expect(townSubTileRadius(10 ** 9)).toBe(TOWN_SUB_TILE_RADIUS_MAX);
    expect(townHouseTarget(500)).toBeLessThan(townHouseTarget(20000));

    const small = generateTownSubTiles(town('town-4', 0, 0, 600), emptyTerrain);
    const large = generateTownSubTiles(town('town-4', 0, 0, 12000), emptyTerrain);
    const countHouses = (m: Map<string, string>) =>
      Array.from(m.values()).filter(k => k === 'house').length;
    expect(countHouses(large)).toBeGreaterThan(countHouses(small));
  });

  it('半径は人口に対して単調非減少で、人口上限(50000)の直前まで飽和しない', () => {
    let prev = townTileRadius(0);
    for (let pop = 500; pop <= 50000; pop += 500) {
      const r = townTileRadius(pop);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    // 20000人で頭打ちだった旧スケールと違い、45000人時点でもまだ最大半径に達しない
    expect(townTileRadius(20000)).toBeLessThan(TOWN_TILE_RADIUS_MAX);
    expect(townTileRadius(45000)).toBeLessThan(TOWN_TILE_RADIUS_MAX);
    expect(townTileRadius(45000)).toBeGreaterThan(townTileRadius(20000));
    expect(townTileRadius(50000)).toBe(TOWN_TILE_RADIUS_MAX);
    // 序盤〜終盤のスケール感: 500人≈2タイル → 50000人=16タイル
    expect(townTileRadius(500)).toBe(2);
    expect(TOWN_TILE_RADIUS_MAX).toBe(16);
  });

  it('人口上限の大都市は広い半径を家で密に埋める(決定的)', () => {
    const t = town('town-metro', 0, 0, 50000);
    const a = generateTownSubTiles(t, emptyTerrain);
    const b = generateTownSubTiles(t, emptyTerrain);
    expect(Array.from(a.entries()).sort()).toEqual(Array.from(b.entries()).sort());

    const houses = Array.from(a.entries()).filter(([, k]) => k === 'house').map(([k]) => fromKey(k));
    // 目標は約1000軒(pop/50)。候補不足を差し引いても大半は埋まる
    expect(houses.length).toBeGreaterThanOrEqual(800);
    expect(houses.length).toBeLessThanOrEqual(townHouseTarget(50000));
    // 実際に外周近くまで市街地が広がっている(サブタイル半径33の8割以上)
    const extent = Math.max(...houses.map(h => Math.max(Math.abs(h.x), Math.abs(h.z))));
    expect(extent).toBeGreaterThanOrEqual(Math.floor(TOWN_SUB_TILE_RADIUS_MAX * 0.8));
  });

  it('人口が増えても既存の家の位置は保たれる(外側へ広がるだけ)', () => {
    const small = generateTownSubTiles(town('town-5', 0, 0, 1500), emptyTerrain);
    const large = generateTownSubTiles(town('town-5', 0, 0, 3000), emptyTerrain);
    for (const [key, kind] of small) {
      if (kind !== 'house') continue;
      // 半径拡大で道路格子上に乗ることはある(kindが変わる)が、サブタイルが消えることはない
      expect(large.has(key)).toBe(true);
    }
  });

  it('家は地面を占有する線路の親タイル(線路・駅・車庫・坂)を避ける', () => {
    const railMap = new Map<string, CellData>();
    for (let x = -15; x <= 15; x++) {
      railMap.set(toKey(x, 1), { type: 'rail', connections: DIR.E | DIR.W });
    }
    const subs = generateTownSubTiles(town('town-6', 0, 0, 9000), emptyTerrain, new Map(), { railMap });
    for (const [key, kind] of subs) {
      if (kind !== 'house') continue;
      expect(parentTileOfSub(fromKey(key).z)).not.toBe(1);
    }
  });

  it('道路は素の線路の親タイルと同居できる(踏切)が、駅・車庫の親タイルには置かれない', () => {
    const railMap = new Map<string, CellData>();
    for (let x = -15; x <= 15; x++) {
      railMap.set(toKey(x, 1), { type: 'rail', connections: DIR.E | DIR.W });
    }
    railMap.set(toKey(0, -3), { type: 'depot', connections: DIR.N });
    const subs = generateTownSubTiles(town('town-7', 0, 0, 9000), emptyTerrain, new Map(), { railMap });
    // 中心(サブ0,0)から南の道路が線路タイル(z=1、サブz∈{2,3})を跨いで続いている=踏切
    expect(subs.get(toKey(0, 2))).toBe('road');
    expect(subs.get(toKey(0, 3))).toBe('road');
    // 車庫タイル(0,-3)=サブz∈{-6,-5}には道路も家も無い
    for (const key of subs.keys()) {
      const { x, z } = fromKey(key);
      expect(`${parentTileOfSub(x)},${parentTileOfSub(z)}`).not.toBe('0,-3');
    }
  });

  it('空の道路格子は刈り込まれる: 全道路サブタイルは家からチェビシェフ距離2以内(平地)', () => {
    for (const pop of [800, 1500, 6000]) {
      const subs = generateTownSubTiles(town('town-prune', 0, 0, pop), emptyTerrain);
      const houses = Array.from(subs.entries()).filter(([, k]) => k === 'house').map(([k]) => fromKey(k));
      const roads = Array.from(subs.entries()).filter(([, k]) => k === 'road').map(([k]) => fromKey(k));
      expect(houses.length).toBeGreaterThan(0);
      for (const r of roads) {
        const dist = Math.min(...houses.map(h => Math.max(Math.abs(h.x - r.x), Math.abs(h.z - r.z))));
        expect(dist).toBeLessThanOrEqual(TOWN_ROAD_PRUNE_DISTANCE);
      }
      // 町の外周に空の道路が突き出ない(家の広がり+刈り込み距離に収まる)
      const roadExtent = Math.max(...roads.map(r => Math.max(Math.abs(r.x), Math.abs(r.z))));
      const houseExtent = Math.max(...houses.map(h => Math.max(Math.abs(h.x), Math.abs(h.z))));
      expect(roadExtent).toBeLessThanOrEqual(houseExtent + TOWN_ROAD_PRUNE_DISTANCE);
    }
  });

  it('刈り込み後も道路は中心から連結で、家から遠い道路は経路上(行き止まりにならない)', () => {
    // 水域で分断気味の地形でも成立することを確認する
    const terrain = new Map<string, TerrainType>();
    for (let z = -16; z <= 16; z++) {
      if (z !== 0) terrain.set(toKey(2, z), 'water');
    }
    const subs = generateTownSubTiles(town('town-prune2', 0, 0, 9000), terrain);
    const roads = new Set(
      Array.from(subs.entries()).filter(([, k]) => k === 'road').map(([key]) => key)
    );
    const houses = Array.from(subs.entries()).filter(([, k]) => k === 'house').map(([k]) => fromKey(k));
    expect(roads.has(toKey(0, 0))).toBe(true);
    // 連結性: 中心からBFSで全道路に到達できる
    const reached = new Set<string>([toKey(0, 0)]);
    const queue = [{ x: 0, z: 0 }];
    while (queue.length > 0) {
      const p = queue.shift()!;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const key = toKey(p.x + dx, p.z + dz);
        if (reached.has(key) || !roads.has(key)) continue;
        reached.add(key);
        queue.push({ x: p.x + dx, z: p.z + dz });
      }
    }
    expect(reached.size).toBe(roads.size);
    // 家から刈り込み距離を超えて残る道路は、中心への接続経路上にある
    // (=行き止まりではない: 道路グラフ上で次数2以上を持つ)
    for (const key of roads) {
      const { x, z } = fromKey(key);
      if (x === 0 && z === 0) continue; // 中心は常に残る
      const dist = Math.min(...houses.map(h => Math.max(Math.abs(h.x - x), Math.abs(h.z - z))));
      if (dist <= TOWN_ROAD_PRUNE_DISTANCE) continue;
      const degree = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .filter(([dx, dz]) => roads.has(toKey(x + dx, z + dz))).length;
      expect(degree).toBeGreaterThanOrEqual(2);
    }
  });

  it('純粋な高架専用セル(地平接続なし)は地面を塞がず、家と同居できる', () => {
    const elevatedOnly: CellData = { type: 'rail', uppers: { 1: { connections: DIR.E | DIR.W } } };
    expect(cellOccupiesGround(elevatedOnly)).toBe(false);
    expect(cellOccupiesGround({ type: 'rail', connections: DIR.E })).toBe(true);
    expect(cellOccupiesGround({ type: 'depot', connections: 0 })).toBe(true);
  });
});

describe('townTiles: タイル粒度への導出', () => {
  it('deriveTileKinds: 家サブが1つでもあれば house、道路サブのみなら road', () => {
    const subs = new Map<string, 'house' | 'road'>([
      // タイル(0,0): 道路2つ+家1つ → house
      [toKey(0, 0), 'road'],
      [toKey(1, 0), 'road'],
      [toKey(0, 1), 'house'],
      // タイル(1,0): 道路のみ → road
      [toKey(2, 0), 'road'],
      // タイル(-1,-1): 家のみ → house
      [toKey(-1, -1), 'house'],
    ]);
    const tiles = deriveTileKinds(subs);
    expect(tiles.get(toKey(0, 0))).toBe('house');
    expect(tiles.get(toKey(1, 0))).toBe('road');
    expect(tiles.get(toKey(-1, -1))).toBe('house');
    expect(tiles.size).toBe(3);
  });

  it('generateTownTilesはサブタイル生成の導出と一致する', () => {
    const t = town('town-8', 3, -2, 5000);
    const subs = generateTownSubTiles(t, emptyTerrain);
    const tiles = generateTownTiles(t, emptyTerrain);
    expect(tiles).toEqual(deriveTileKinds(subs));
    expect(tiles.size).toBeGreaterThan(0);
    // 全タイルキーはサブタイルの親タイルの集合と一致する
    const parents = new Set(
      Array.from(subs.keys()).map(key => {
        const { x, z } = fromKey(key);
        return toKey(parentTileOfSub(x), parentTileOfSub(z));
      })
    );
    expect(new Set(tiles.keys())).toEqual(parents);
  });

  it('線路が横切るタイルは家サブが無いので road のまま(踏切になれる)', () => {
    const railMap = new Map<string, CellData>();
    for (let x = -15; x <= 15; x++) {
      railMap.set(toKey(x, 1), { type: 'rail', connections: DIR.E | DIR.W });
    }
    const tiles = generateTownTiles(town('town-9', 0, 0, 9000), emptyTerrain, new Map(), { railMap });
    for (const [key, kind] of tiles) {
      if (fromKey(key).z === 1) expect(kind).toBe('road');
    }
    // 中心から南へ道路が線路を跨いでいる
    expect(tiles.get(toKey(0, 1))).toBe('road');
  });
});

describe('townTiles: 合成索引(buildTownIndexes)', () => {
  it('近接する2つの町のタイルは重複せず、先の町が先勝ちする', () => {
    const a = town('town-a', 0, 0, 20000);
    const b = town('town-b', 6, 0, 20000);
    const index = buildTownTileIndex([a, b], emptyTerrain);

    const standaloneA = generateTownTiles(a, emptyTerrain);
    // aのタイルはすべて索引でもaの所有
    for (const key of standaloneA.keys()) {
      expect(index.get(key)?.townId).toBe('town-a');
    }
    // bのタイルはaの領域を避けている
    for (const [, entry] of index) {
      expect(['town-a', 'town-b']).toContain(entry.townId);
    }
  });

  it('buildTownIndexesはタイル索引とサブタイル索引を整合させて返す', () => {
    const t = town('town-c2', 0, 0, 4000);
    const { tiles, subTiles } = buildTownIndexes([t], emptyTerrain);
    expect(subTiles.size).toBeGreaterThan(0);
    // サブタイルの親タイルは必ずタイル索引にあり、家サブの親は必ず'house'
    for (const [key, entry] of subTiles) {
      const { x, z } = fromKey(key);
      const parent = tiles.get(toKey(parentTileOfSub(x), parentTileOfSub(z)));
      expect(parent?.townId).toBe('town-c2');
      if (entry.kind === 'house') expect(parent?.kind).toBe('house');
    }
  });

  it('isTownBlockedは家のみtrue、道路・空地はfalse', () => {
    const t = town('town-c', 0, 0, 4000);
    const index = buildTownTileIndex([t], emptyTerrain);
    const houseKey = Array.from(index.entries()).find(([, e]) => e.kind === 'house')![0];
    const roadKey = Array.from(index.entries()).find(([, e]) => e.kind === 'road')![0];
    const house = fromKey(houseKey);
    const road = fromKey(roadKey);
    expect(isTownBlocked(index, road.x, road.z)).toBe(false);
    expect(isTownBlocked(index, house.x, house.z)).toBe(true);
    expect(isTownBlocked(index, 40, 40)).toBe(false);
    expect(townTileAt(index, house.x, house.z)?.kind).toBe('house');
  });
});

describe('construction: 町タイルの建設ガード', () => {
  // (0,0)中心の町を作り、家タイル1つと「東西の隣が家でない道路タイル」を見つけて使う
  const t = town('town-guard', 0, 0, 4000);
  const index = buildTownTileIndex([t], emptyTerrain);
  const houseKey = Array.from(index.entries()).find(([, e]) => e.kind === 'house')![0];
  const house = fromKey(houseKey);
  const crossable = Array.from(index.entries())
    .filter(([, e]) => e.kind === 'road')
    .map(([key]) => fromKey(key))
    .find(p =>
      !isTownBlocked(index, p.x - 1, p.z) && !isTownBlocked(index, p.x + 1, p.z));
  const emptyState = (): ConstructionState => ({ railMap: new Map(), stations: new Map() });

  it('地平の線路は家タイルを通れない(no-op、同一参照)', () => {
    const state = emptyState();
    const path = [
      { x: house.x - 1, z: house.z },
      { x: house.x, z: house.z },
      { x: house.x + 1, z: house.z },
    ];
    const result = applyRailPathDetailed(state, path, emptyTerrain, undefined, index);
    expect(result.railMap).toBe(state.railMap);
    // townTilesを渡さなければ従来通り建設できる(後方互換)
    const legacy = applyRailPath(state, path, emptyTerrain);
    expect(legacy.railMap).not.toBe(state.railMap);
  });

  it('地平の線路は道路タイルを通れる(踏切)', () => {
    expect(crossable).toBeDefined();
    const { x, z } = crossable!;
    const state = emptyState();
    const path = [
      { x: x - 1, z },
      { x, z },
      { x: x + 1, z },
    ];
    expect(index.get(toKey(x, z))?.kind).toBe('road');
    const result = applyRailPath(state, path, emptyTerrain, undefined, index);
    expect(result.railMap).not.toBe(state.railMap);
    expect(result.railMap.get(toKey(x, z))?.connections).toBe(DIR.E | DIR.W);
  });

  it('高架線は家タイルの上を通れるが、坂になるセルが家タイルだと建設できない', () => {
    // 家タイルを跨ぐ十分長い直線経路(両端は町の外)
    const z = house.z;
    const path = Array.from({ length: 11 }, (_, i) => ({ x: house.x - 5 + i, z }));
    const pathIsClearAtEnds = path.slice(0, 3).every(p => !isTownBlocked(index, p.x, p.z))
      && path.slice(-3).every(p => !isTownBlocked(index, p.x, p.z));

    if (pathIsClearAtEnds) {
      const state = emptyState();
      const result = applyElevatedPath(state, path, emptyTerrain, 1, undefined, index);
      expect(result.railMap).not.toBe(state.railMap);
      // 家の上は橋桁(uppers)になっている
      expect(result.railMap.get(houseKey)?.uppers?.[1]?.connections).toBeTruthy();
    }

    // 坂が家タイルに乗る経路: 家タイルを端(=地平へ降りる坂)にする。
    // 空マップでは端がflat(浮いた高架)になり坂ができないため、applyBridgeと同じ
    // forcedEndsで両端を地平接続(=2セルずつ坂)に強制する。
    const rampPath = Array.from({ length: 6 }, (_, i) => ({ x: house.x + i, z }));
    const state2 = emptyState();
    const result2 = applyElevatedPath(
      state2, rampPath, emptyTerrain, 1,
      { start: { kind: 'connect', level: 0 }, end: { kind: 'connect', level: 0 } },
      index
    );
    expect(result2.railMap).toBe(state2.railMap);
  });

  it('駅・車庫は家タイルにも道路タイルにも置けない', () => {
    const state = emptyState();
    const road = crossable!;
    expect(applyStation(state, house, emptyTerrain, [], undefined, index)).toBe(state);
    expect(applyStation(state, road, emptyTerrain, [], undefined, index)).toBe(state);
    expect(applyDepot(state, house, emptyTerrain, index)).toBe(state);
    expect(applyDepot(state, road, emptyTerrain, index)).toBe(state);
    // 町の外には従来通り置ける
    expect(applyDepot(state, { x: 40, z: 40 }, emptyTerrain, index)).not.toBe(state);
  });

  it('信号は道路タイル(踏切)には置けない', () => {
    // 道路タイルを線路が横切っている状態を作る
    const { x, z } = crossable!;
    const state = emptyState();
    const built = applyRailPath(state, [
      { x: x - 1, z }, { x, z }, { x: x + 1, z },
    ], emptyTerrain, undefined, index);
    const result = applySignal(built, [{ x, z }], emptyTerrain, index);
    expect(result).toBe(built);
    // 町の外の線路には従来通り置ける
    const outside = applyRailPath(emptyState(), [
      { x: 40, z: 40 }, { x: 41, z: 40 },
    ], emptyTerrain);
    expect(applySignal(outside, [{ x: 40, z: 40 }], emptyTerrain, index)).not.toBe(outside);
  });
});
