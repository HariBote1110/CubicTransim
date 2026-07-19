import { describe, expect, it } from 'vitest';
import { mulberry32, generateTowns, TOWN_MIN_DISTANCE, TOWN_COORD_RANGE, TOWN_POPULATION_MIN, TOWN_POPULATION_MAX } from './towns';

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
