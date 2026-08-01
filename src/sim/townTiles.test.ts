import { describe, it, expect } from 'vitest';
import type { CellData, TerrainType, TownData } from '../types';
import { toKey, fromKey } from '../utils';
import {
  generateTownTiles,
  buildTownTileIndex,
  isTownBlocked,
  townTileAt,
  townTileRadius,
  townHouseTarget,
  cellOccupiesGround,
  TOWN_TILE_RADIUS_MAX,
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

describe('townTiles: 生成', () => {
  it('同じ入力からは常に同じタイル配置になる(決定的)', () => {
    const t = town('town-0', 5, -3, 2400);
    const a = generateTownTiles(t, emptyTerrain);
    const b = generateTownTiles(t, emptyTerrain);
    expect(a.size).toBeGreaterThan(0);
    expect(Array.from(a.entries()).sort()).toEqual(Array.from(b.entries()).sort());
  });

  it('中心タイルは道路になり、全道路タイルは中心から4近傍で辿れる', () => {
    const t = town('town-1', 0, 0, 6000);
    const tiles = generateTownTiles(t, emptyTerrain);
    expect(tiles.get(toKey(0, 0))).toBe('road');

    const roads = new Set(
      Array.from(tiles.entries()).filter(([, k]) => k === 'road').map(([key]) => key)
    );
    // BFSで中心から到達できる道路タイルを数える
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

  it('家は必ず道路タイルに4近傍で隣接する', () => {
    const t = town('town-2', 0, 0, 4000);
    const tiles = generateTownTiles(t, emptyTerrain);
    const houses = Array.from(tiles.entries()).filter(([, k]) => k === 'house');
    expect(houses.length).toBeGreaterThan(0);
    for (const [key] of houses) {
      const { x, z } = fromKey(key);
      const adjacent = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(
        ([dx, dz]) => tiles.get(toKey(x + dx, z + dz)) === 'road'
      );
      expect(adjacent).toBe(true);
    }
  });

  it('水域・山岳・標高1以上のセルにはタイルを置かない', () => {
    const terrain = new Map<string, TerrainType>();
    const heights = new Map<string, number>();
    // 中心の東側を水域、西側を山岳(標高1)にする
    for (let z = -8; z <= 8; z++) {
      terrain.set(toKey(2, z), 'water');
      terrain.set(toKey(-2, z), 'mountain');
      heights.set(toKey(-2, z), 1);
    }
    const t = town('town-3', 0, 0, 8000);
    const tiles = generateTownTiles(t, terrain, heights);
    for (const key of tiles.keys()) {
      const { x } = fromKey(key);
      expect(x).not.toBe(2);
      expect(x).not.toBe(-2);
    }
  });

  it('人口が多いほど半径・家の数が増える(視覚的に成長する)', () => {
    expect(townTileRadius(500)).toBeLessThan(townTileRadius(20000));
    expect(townTileRadius(10 ** 9)).toBe(TOWN_TILE_RADIUS_MAX);
    expect(townHouseTarget(500)).toBeLessThan(townHouseTarget(20000));

    const small = generateTownTiles(town('town-4', 0, 0, 600), emptyTerrain);
    const large = generateTownTiles(town('town-4', 0, 0, 12000), emptyTerrain);
    const countHouses = (m: Map<string, string>) =>
      Array.from(m.values()).filter(k => k === 'house').length;
    expect(countHouses(large)).toBeGreaterThan(countHouses(small));
  });

  it('人口が増えても既存の家の位置は保たれる(外側へ広がるだけ)', () => {
    const small = generateTownTiles(town('town-5', 0, 0, 1500), emptyTerrain);
    const large = generateTownTiles(town('town-5', 0, 0, 3000), emptyTerrain);
    for (const [key, kind] of small) {
      if (kind !== 'house') continue;
      // 半径拡大で道路格子上に乗ることはある(kindが変わる)が、タイルが消えることはない
      expect(large.has(key)).toBe(true);
    }
  });

  it('家は地面を占有する線路セル(線路・駅・車庫・坂)を避ける', () => {
    const railMap = new Map<string, CellData>();
    for (let x = -7; x <= 7; x++) {
      railMap.set(toKey(x, 1), { type: 'rail', connections: DIR.E | DIR.W });
    }
    const tiles = generateTownTiles(town('town-6', 0, 0, 9000), emptyTerrain, new Map(), { railMap });
    for (const [key, kind] of tiles) {
      if (kind !== 'house') continue;
      expect(fromKey(key).z).not.toBe(1);
    }
  });

  it('道路は素の線路セルと同居できる(踏切)が、駅・車庫セルには置かれない', () => {
    const railMap = new Map<string, CellData>();
    for (let x = -7; x <= 7; x++) {
      railMap.set(toKey(x, 1), { type: 'rail', connections: DIR.E | DIR.W });
    }
    railMap.set(toKey(0, -3), { type: 'depot', connections: DIR.N });
    const tiles = generateTownTiles(town('town-7', 0, 0, 9000), emptyTerrain, new Map(), { railMap });
    // 中心(0,0)から南北の道路が線路(z=1)を跨いで続いている=踏切
    expect(tiles.get(toKey(0, 1))).toBe('road');
    expect(tiles.get(toKey(0, -3))).toBeUndefined();
  });

  it('純粋な高架専用セル(地平接続なし)は地面を塞がず、家と同居できる', () => {
    const elevatedOnly: CellData = { type: 'rail', uppers: { 1: { connections: DIR.E | DIR.W } } };
    expect(cellOccupiesGround(elevatedOnly)).toBe(false);
    expect(cellOccupiesGround({ type: 'rail', connections: DIR.E })).toBe(true);
    expect(cellOccupiesGround({ type: 'depot', connections: 0 })).toBe(true);
  });
});

describe('townTiles: 合成索引(buildTownTileIndex)', () => {
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

  it('isTownBlockedは家のみtrue、道路・空地はfalse', () => {
    const t = town('town-c', 0, 0, 4000);
    const index = buildTownTileIndex([t], emptyTerrain);
    expect(isTownBlocked(index, 0, 0)).toBe(false); // 中心=道路
    const houseKey = Array.from(index.entries()).find(([, e]) => e.kind === 'house')![0];
    const { x, z } = fromKey(houseKey);
    expect(isTownBlocked(index, x, z)).toBe(true);
    expect(isTownBlocked(index, 40, 40)).toBe(false);
    expect(townTileAt(index, x, z)?.kind).toBe('house');
  });
});

describe('construction: 町タイルの建設ガード', () => {
  // (0,0)中心の町を作り、家タイル1つと道路タイル1つを見つけて使う
  const t = town('town-guard', 0, 0, 4000);
  const index = buildTownTileIndex([t], emptyTerrain);
  const houseKey = Array.from(index.entries()).find(([, e]) => e.kind === 'house')![0];
  const house = fromKey(houseKey);
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
    const state = emptyState();
    // 中心(0,0)は道路。そこを東西に横切る
    const path = [
      { x: -1, z: 0 },
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    ];
    expect(index.get(toKey(0, 0))?.kind).toBe('road');
    const result = applyRailPath(state, path, emptyTerrain, undefined, index);
    expect(result.railMap).not.toBe(state.railMap);
    expect(result.railMap.get(toKey(0, 0))?.connections).toBe(DIR.E | DIR.W);
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
    expect(applyStation(state, house, emptyTerrain, [], undefined, index)).toBe(state);
    expect(applyStation(state, { x: 0, z: 0 }, emptyTerrain, [], undefined, index)).toBe(state);
    expect(applyDepot(state, house, emptyTerrain, index)).toBe(state);
    expect(applyDepot(state, { x: 0, z: 0 }, emptyTerrain, index)).toBe(state);
    // 町の外には従来通り置ける
    expect(applyDepot(state, { x: 30, z: 30 }, emptyTerrain, index)).not.toBe(state);
  });

  it('信号は道路タイル(踏切)には置けない', () => {
    // 道路タイル(0,0)を線路が横切っている状態を作る
    const state = emptyState();
    const built = applyRailPath(state, [
      { x: -1, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 },
    ], emptyTerrain, undefined, index);
    const result = applySignal(built, [{ x: 0, z: 0 }], emptyTerrain, index);
    expect(result).toBe(built);
    // 町の外の線路には従来通り置ける
    const outside = applyRailPath(emptyState(), [
      { x: 30, z: 30 }, { x: 31, z: 30 },
    ], emptyTerrain);
    expect(applySignal(outside, [{ x: 30, z: 30 }], emptyTerrain, index)).not.toBe(outside);
  });
});
