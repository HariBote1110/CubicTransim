// 街(town)の生成ロジック。純粋関数のみ。React/THREE には依存しない。
import type { TerrainType, TownData } from '../types';
import { fromKey } from '../utils';

export const TOWN_COORD_RANGE = 40; // 中心座標は -40..40
export const TOWN_MIN_DISTANCE = 12; // 街同士の最低距離(タイル)
export const TOWN_POPULATION_MIN = 500;
export const TOWN_POPULATION_MAX = 5000;
export const TOWN_TERRAIN_AVOID_RADIUS = 3; // 水域・山岳セルからこの半径以内には街を生成しない
const MAX_ATTEMPTS_PER_TOWN = 500; // rejection samplingの試行回数上限

// 候補座標が水域・山岳セルの半径TOWN_TERRAIN_AVOID_RADIUS以内にあるかどうかを判定する。
const isNearTerrain = (
  x: number,
  z: number,
  terrain: Map<string, TerrainType>,
  radius: number
): boolean => {
  for (const key of terrain.keys()) {
    const { x: tx, z: tz } = fromKey(key);
    if (Math.hypot(tx - x, tz - z) <= radius) return true;
  }
  return false;
};

// シード付き決定的疑似乱数生成器(mulberry32)。テストの再現性のために使用する。
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// マップ上に人口を持つ街を生成する。中心座標は rejection sampling で
// 最低 TOWN_MIN_DISTANCE 離すよう決定的に配置する。
export function generateTowns(
  rng: () => number,
  count = 8,
  terrain: Map<string, TerrainType> = new Map()
): TownData[] {
  const towns: TownData[] = [];

  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_TOWN; attempt++) {
      const x = Math.round((rng() * 2 - 1) * TOWN_COORD_RANGE);
      const z = Math.round((rng() * 2 - 1) * TOWN_COORD_RANGE);

      const farEnough = towns.every(
        t => Math.hypot(t.centre.x - x, t.centre.z - z) >= TOWN_MIN_DISTANCE
      );
      // 街は必ず平地に生成される: 水域・山岳セルの半径TOWN_TERRAIN_AVOID_RADIUS以内は避ける
      const avoidsTerrain = !isNearTerrain(x, z, terrain, TOWN_TERRAIN_AVOID_RADIUS);

      if (farEnough && avoidsTerrain) {
        const population = Math.round(
          TOWN_POPULATION_MIN + rng() * (TOWN_POPULATION_MAX - TOWN_POPULATION_MIN)
        );
        towns.push({ id: `town-${i}`, centre: { x, z }, population });
        break;
      }
    }
  }

  return towns;
}
