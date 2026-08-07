import { describe, expect, it } from 'vitest';
import type { CellData, StationData, TerrainType, TownData } from '../types';
import { generateMap } from './terrain';
import { fieldFromMaps } from './terrainField';
import {
  mulberry32, generateTowns, growTown, townServiceLevel,
  TOWN_MIN_DISTANCE, TOWN_COORD_RANGE, TOWN_POPULATION_MIN, TOWN_POPULATION_MAX, TOWN_POPULATION_CAP,
  TOWN_STATION_RADIUS,
  nearestTownWithinRadius, stationNameForTown,
  NEW_TOWN_POPULATION_MIN, NEW_TOWN_POPULATION_MAX,
  resolveTownSpawnTick, townSpawnChance, TOWN_SPAWN_CAPACITY_THRESHOLD, TOWN_SPAWN_BASE_CHANCE,
  type StationTransportInfo,
} from './towns';

describe('mulberry32', () => {
  it('同じシードからは同じ乱数列が決定的に得られる', () => {
    const rngA = mulberry32(12345);
    const rngB = mulberry32(12345);
    const seqA = Array.from({ length: 10 }, () => rngA());
    const seqB = Array.from({ length: 10 }, () => rngB());
    expect(seqA).toEqual(seqB);
  });

  it('異なるシードからは異なる乱数列が得られる', () => {
    const rngA = mulberry32(1);
    const rngB = mulberry32(2);
    expect(rngA()).not.toBe(rngB());
  });

  it('返り値は常に[0, 1)の範囲に収まる', () => {
    const rng = mulberry32(999);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('generateTowns', () => {
  it('同じシードからは同じ街配置が決定的に得られる', () => {
    const townsA = generateTowns(mulberry32(42), 8);
    const townsB = generateTowns(mulberry32(42), 8);
    expect(townsA).toEqual(townsB);
  });

  it('指定した個数の街が生成される', () => {
    const towns = generateTowns(mulberry32(42), 8);
    expect(towns.length).toBe(8);
  });

  it('中心座標は-40..40の範囲に収まる', () => {
    const towns = generateTowns(mulberry32(7), 8);
    for (const town of towns) {
      expect(town.centre.x).toBeGreaterThanOrEqual(-TOWN_COORD_RANGE);
      expect(town.centre.x).toBeLessThanOrEqual(TOWN_COORD_RANGE);
      expect(town.centre.z).toBeGreaterThanOrEqual(-TOWN_COORD_RANGE);
      expect(town.centre.z).toBeLessThanOrEqual(TOWN_COORD_RANGE);
    }
  });

  it('街同士は最低TOWN_MIN_DISTANCE離れている', () => {
    const towns = generateTowns(mulberry32(7), 8);
    for (let i = 0; i < towns.length; i++) {
      for (let j = i + 1; j < towns.length; j++) {
        const dist = Math.hypot(
          towns[i].centre.x - towns[j].centre.x,
          towns[i].centre.z - towns[j].centre.z
        );
        expect(dist).toBeGreaterThanOrEqual(TOWN_MIN_DISTANCE);
      }
    }
  });

  it('populationは500〜5000の範囲に収まる', () => {
    const towns = generateTowns(mulberry32(7), 8);
    for (const town of towns) {
      expect(town.population).toBeGreaterThanOrEqual(TOWN_POPULATION_MIN);
      expect(town.population).toBeLessThanOrEqual(TOWN_POPULATION_MAX);
    }
  });

  it('各街のidは一意である', () => {
    const towns = generateTowns(mulberry32(7), 8);
    const ids = new Set(towns.map(t => t.id));
    expect(ids.size).toBe(towns.length);
  });

  it('標高地形(generateMap)を渡しても、街は必ず平地(標高0の草地)に8つ生成される', () => {
    // 標高が一次データになりmountainセルが数千個規模になっても、
    // rejection samplingが平地を見つけて8つの街を置けることを確認する。
    for (const seed of [1, 42, 2026]) {
      const { terrain, heights } = generateMap(mulberry32(seed));
      const towns = generateTowns(mulberry32(seed + 1), 8, fieldFromMaps(heights, terrain, 45));
      expect(towns.length).toBe(8);
      for (const town of towns) {
        const key = `${town.centre.x},${town.centre.z}`;
        expect(terrain.has(key)).toBe(false); // 水域・山岳ではない
        expect(heights.has(key)).toBe(false); // 標高0の平地
      }
    }
  });

  it('terrainを渡すと水域セルの半径3タイル以内には街が生成されない', () => {
    // マップ中央付近を広く水域で埋め、街がその近傍を避けることを確認する
    const terrain = new Map<string, 'water' | 'mountain'>();
    for (let x = -5; x <= 5; x++) {
      for (let z = -5; z <= 5; z++) {
        terrain.set(`${x},${z}`, 'water');
      }
    }

    const towns = generateTowns(mulberry32(7), 8, fieldFromMaps(new Map(), terrain, 45));
    for (const town of towns) {
      for (const key of terrain.keys()) {
        const [tx, tz] = key.split(',').map(Number);
        const dist = Math.hypot(town.centre.x - tx, town.centre.z - tz);
        expect(dist).toBeGreaterThan(3);
      }
    }
  });
});

describe('町名', () => {
  it('生成された街には名前が付く', () => {
    const towns = generateTowns(mulberry32(42), 8);
    for (const town of towns) {
      expect(town.name).toBeTruthy();
      expect(town.name.endsWith('町') || town.name.endsWith('市') || town.name.endsWith('村')).toBe(true);
    }
  });

  it('同じシードなら町名も同じ(決定的)', () => {
    const a = generateTowns(mulberry32(7), 8).map(t => t.name);
    const b = generateTowns(mulberry32(7), 8).map(t => t.name);
    expect(a).toEqual(b);
  });

  it('町名は重複しない', () => {
    const names = generateTowns(mulberry32(3), 8).map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('街の成長', () => {
  const town = (population: number): TownData => ({
    id: 'town-0', name: 'テスト町', centre: { x: 0, z: 0 }, population,
  });

  it('鉄道が使える町は人口が増える', () => {
    const grown = growTown(town(1000), 1);
    expect(grown.population).toBeGreaterThan(1000);
  });

  it('鉄道が無い町は人口が変わらない', () => {
    expect(growTown(town(1000), 0).population).toBe(1000);
  });

  it('鉄道の便がよいほど成長が速い', () => {
    const slow = growTown(town(1000), 0.3).population;
    const fast = growTown(town(1000), 1).population;
    expect(fast).toBeGreaterThan(slow);
  });

  it('人口は上限で頭打ちになる', () => {
    expect(growTown(town(TOWN_POPULATION_CAP), 1).population).toBe(TOWN_POPULATION_CAP);
  });

  it('人口は整数のまま保たれる', () => {
    expect(Number.isInteger(growTown(town(1234), 0.55).population)).toBe(true);
  });
});

describe('町の鉄道アクセス(serviceLevel)', () => {
  const stations = new Map<string, StationData>([
    ['near', { id: 'near', name: '近駅', cells: [], center: { x: 1, z: 0 }, platformDoors: 'none' }],
    ['far', { id: 'far', name: '遠駅', cells: [], center: { x: 40, z: 0 }, platformDoors: 'none' }],
  ]);
  const town: TownData = { id: 'town-0', name: 'テスト町', centre: { x: 0, z: 0 }, population: 1000 };

  it('列車が停まる駅が近くにあれば1に近い', () => {
    expect(townServiceLevel(town, stations, new Set(['near']))).toBeGreaterThan(0.8);
  });

  it('駅はあっても列車が来ないなら0', () => {
    expect(townServiceLevel(town, stations, new Set())).toBe(0);
  });

  it('遠い駅しか無ければ0', () => {
    expect(townServiceLevel(town, stations, new Set(['far']))).toBe(0);
  });
});

describe('nearestTownWithinRadius', () => {
  const minamimiya: TownData = { id: 'town-0', name: '南宮市', centre: { x: 0, z: 0 }, population: 1000 };
  const furusato: TownData = { id: 'town-1', name: '古里市', centre: { x: 30, z: 30 }, population: 1000 };
  const towns = [minamimiya, furusato];

  it('半径内に町があればそれを返す', () => {
    expect(nearestTownWithinRadius({ x: 2, z: 0 }, towns)).toBe(minamimiya);
  });

  it('半径内に複数あれば最も近い町を返す', () => {
    const close: TownData = { id: 'town-2', name: '近町', centre: { x: 1, z: 0 }, population: 1000 };
    expect(nearestTownWithinRadius({ x: 2, z: 0 }, [minamimiya, close])).toBe(close);
  });

  it('半径外にしか町が無ければnull', () => {
    expect(nearestTownWithinRadius({ x: TOWN_STATION_RADIUS + 5, z: 0 }, towns)).toBeNull();
  });
});

describe('stationNameForTown', () => {
  const minamimiya: TownData = { id: 'town-0', name: '南宮市', centre: { x: 0, z: 0 }, population: 1000 };

  it('町の名前(接尾語を除く)＋駅、を返す', () => {
    expect(stationNameForTown(minamimiya, { x: 2, z: 0 }, new Set())).toBe('南宮駅');
  });

  it('既に使われていれば東西南北つきの名前になる(町の東)', () => {
    const used = new Set(['南宮駅']);
    expect(stationNameForTown(minamimiya, { x: 5, z: 0 }, used)).toBe('東南宮駅');
  });

  it('町の北にあれば北南宮駅になる', () => {
    const used = new Set(['南宮駅']);
    expect(stationNameForTown(minamimiya, { x: 0, z: -5 }, used)).toBe('北南宮駅');
  });

  it('方角つきの名前も埋まっていれば中央→新→台/森/谷/浜/橋の順に進む', () => {
    const used = new Set(['南宮駅', '東南宮駅']);
    expect(stationNameForTown(minamimiya, { x: 5, z: 0 }, used)).toBe('南宮中央駅');

    used.add('南宮中央駅');
    expect(stationNameForTown(minamimiya, { x: 5, z: 0 }, used)).toBe('新南宮駅');

    used.add('新南宮駅');
    expect(stationNameForTown(minamimiya, { x: 5, z: 0 }, used)).toBe('南宮台駅');

    used.add('南宮台駅');
    expect(stationNameForTown(minamimiya, { x: 5, z: 0 }, used)).toBe('南宮森駅');
  });

  it('全部埋まっていれば番号付きになり、必ず一意な名前を返す', () => {
    const used = new Set([
      '南宮駅', '東南宮駅', '南宮中央駅', '新南宮駅',
      '南宮台駅', '南宮森駅', '南宮谷駅', '南宮浜駅', '南宮橋駅',
      '南宮第2駅',
    ]);
    const name = stationNameForTown(minamimiya, { x: 5, z: 0 }, used);
    expect(name).toBe('南宮第3駅');
    expect(used.has(name)).toBe(false);
  });
});

describe('townSpawnChance', () => {
  it('閾値未満の輸送力では0', () => {
    expect(townSpawnChance(TOWN_SPAWN_CAPACITY_THRESHOLD - 1)).toBe(0);
  });

  it('ちょうど閾値ではTOWN_SPAWN_BASE_CHANCE', () => {
    expect(townSpawnChance(TOWN_SPAWN_CAPACITY_THRESHOLD)).toBeCloseTo(TOWN_SPAWN_BASE_CHANCE);
  });

  it('輸送力に応じて線形に増え、1で頭打ちになる', () => {
    expect(townSpawnChance(TOWN_SPAWN_CAPACITY_THRESHOLD * 2)).toBeCloseTo(TOWN_SPAWN_BASE_CHANCE * 2);
    expect(townSpawnChance(TOWN_SPAWN_CAPACITY_THRESHOLD * 1000)).toBe(1);
  });
});

describe('resolveTownSpawnTick', () => {
  const emptyField = fieldFromMaps(new Map(), new Map(), 200);

  it('駅があっても列車が停まらない(capacity=0)なら何度チェックしても湧かない', () => {
    const infos: StationTransportInfo[] = [{ stationId: 's1', pos: { x: 100, z: 100 }, capacity: 0 }];
    const alwaysZero = () => 0;
    const result = resolveTownSpawnTick(infos, [], emptyField, alwaysZero);
    expect(result.spawnedTowns).toEqual([]);
    expect(result.towns).toEqual([]);
  });

  it('輸送力が閾値未満なら湧かない', () => {
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD - 1 },
    ];
    const alwaysZero = () => 0;
    const result = resolveTownSpawnTick(infos, [], emptyField, alwaysZero);
    expect(result.spawnedTowns).toEqual([]);
  });

  it('輸送力が閾値以上・rngが十分低ければ湧く', () => {
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD },
    ];
    const alwaysZero = () => 0;
    const result = resolveTownSpawnTick(infos, [], emptyField, alwaysZero);
    expect(result.spawnedTowns.length).toBe(1);
    expect(result.towns).toEqual(result.spawnedTowns);
  });

  it('rngがchance以上を返せば湧かない(towns参照は不変)', () => {
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD },
    ];
    const alwaysHigh = () => 0.999;
    const towns: TownData[] = [];
    const result = resolveTownSpawnTick(infos, towns, emptyField, alwaysHigh);
    expect(result.spawnedTowns).toEqual([]);
    expect(result.towns).toBe(towns);
  });

  it('近くに既に町があれば輸送力十分でも湧かない', () => {
    const existing: TownData[] = [{ id: 'town-0', name: '南宮市', centre: { x: 100, z: 100 }, population: 1000 }];
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD * 5 },
    ];
    const alwaysZero = () => 0;
    const result = resolveTownSpawnTick(infos, existing, emptyField, alwaysZero);
    expect(result.spawnedTowns).toEqual([]);
    expect(result.towns).toBe(existing);
  });

  it('十分なティック(日次呼び出しの繰り返し)を重ねれば決定的に湧く', () => {
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD * 2 },
    ];
    const rng = mulberry32(7);
    let towns: TownData[] = [];
    let spawned = false;
    for (let day = 0; day < 500 && !spawned; day++) {
      const result = resolveTownSpawnTick(infos, towns, emptyField, rng);
      towns = result.towns;
      if (result.spawnedTowns.length > 0) spawned = true;
    }
    expect(spawned).toBe(true);
  });

  it('人口はNEW_TOWN_POPULATION_MIN〜MAXの範囲', () => {
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD },
    ];
    const alwaysZero = () => 0;
    const result = resolveTownSpawnTick(infos, [], emptyField, alwaysZero);
    const spawned = result.spawnedTowns[0];
    expect(spawned.population).toBeGreaterThanOrEqual(NEW_TOWN_POPULATION_MIN);
    expect(spawned.population).toBeLessThanOrEqual(NEW_TOWN_POPULATION_MAX);
  });

  it('水域・山岳の上には町を作らない(駅周辺が全部水没していれば湧かない)', () => {
    const terrain: Map<string, TerrainType> = new Map();
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        terrain.set(`${100 + dx},${100 + dz}`, 'water');
      }
    }
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD },
    ];
    const alwaysZero = () => 0;
    const result = resolveTownSpawnTick(infos, [], fieldFromMaps(new Map(), terrain, 200), alwaysZero);
    expect(result.spawnedTowns).toEqual([]);
  });

  it('線路・駅・車庫が地面を占有するセルの上には町の中心を置かない', () => {
    // 駅(100,100)の周囲1〜3タイルの全候補セルに地平の線路を敷き詰める
    const railMap = new Map<string, CellData>();
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        railMap.set(`${100 + dx},${100 + dz}`, { type: 'rail', connections: 1 });
      }
    }
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD },
    ];
    const alwaysZero = () => 0;
    const blocked = resolveTownSpawnTick(infos, [], emptyField, alwaysZero, railMap);
    expect(blocked.spawnedTowns).toEqual([]);

    // 純粋な高架専用セル(地平接続なし)は地面を塞がないので湧ける
    const elevatedOnly = new Map<string, CellData>();
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        elevatedOnly.set(`${100 + dx},${100 + dz}`, {
          type: 'rail', connections: 0, uppers: { 1: { connections: 1 } },
        });
      }
    }
    const allowed = resolveTownSpawnTick(infos, [], emptyField, alwaysZero, elevatedOnly);
    expect(allowed.spawnedTowns.length).toBe(1);
  });
});
