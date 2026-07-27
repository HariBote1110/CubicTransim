import { describe, expect, it } from 'vitest';
import type { StationData, TownData } from '../types';
import {
  mulberry32, generateTowns, growTown, townServiceLevel,
  TOWN_MIN_DISTANCE, TOWN_COORD_RANGE, TOWN_POPULATION_MIN, TOWN_POPULATION_MAX, TOWN_POPULATION_CAP,
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

  it('terrainを渡すと水域セルの半径3タイル以内には街が生成されない', () => {
    // マップ中央付近を広く水域で埋め、街がその近傍を避けることを確認する
    const terrain = new Map<string, 'water' | 'mountain'>();
    for (let x = -5; x <= 5; x++) {
      for (let z = -5; z <= 5; z++) {
        terrain.set(`${x},${z}`, 'water');
      }
    }

    const towns = generateTowns(mulberry32(7), 8, terrain);
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
