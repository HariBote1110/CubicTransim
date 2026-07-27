// 街(town)の生成ロジック。純粋関数のみ。React/THREE には依存しない。
import type { StationData, TerrainType, TownData } from '../types';
import { fromKey } from '../utils';

export const TOWN_COORD_RANGE = 40; // 中心座標は -40..40
export const TOWN_MIN_DISTANCE = 12; // 街同士の最低距離(タイル)
export const TOWN_POPULATION_MIN = 500;
export const TOWN_POPULATION_MAX = 5000;
/** 人口の上限。鉄道が便利でもこれ以上は増えない。 */
export const TOWN_POPULATION_CAP = 50_000;
/** 鉄道アクセスが最良(serviceLevel=1)のときの月あたり人口増加率。 */
export const TOWN_GROWTH_RATE_MAX = 0.03;
/** 街の中心からこの距離(タイル)までの駅を「その町の駅」とみなす。 */
export const TOWN_STATION_RADIUS = 10;
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

// 町名の構成要素。前部＋中部＋接尾で組み立てる(例: 青野町、東川市)。
const NAME_PREFIX = [
  '青', '白', '大', '小', '新', '東', '西', '南', '北', '上',
  '下', '中', '本', '高', '古', '長', '春', '秋', '緑', '桜',
] as const;
const NAME_STEM = [
  '野', '山', '川', '田', '原', '橋', '森', '丘', '浜', '谷',
  '沢', '島', '台', '井', '浦', '宮', '木', '池', '岡', '里',
] as const;
const NAME_SUFFIX = ['町', '市', '村'] as const;

// 未使用の町名を1つ引く。組み合わせが尽きることは実際上ないが、
// 万一すべて埋まった場合に無限ループしないよう試行回数で打ち切る。
const nextTownName = (rng: () => number, used: Set<string>): string => {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];
  for (let attempt = 0; attempt < 200; attempt++) {
    const name = `${pick(NAME_PREFIX)}${pick(NAME_STEM)}${pick(NAME_SUFFIX)}`;
    if (!used.has(name)) return name;
  }
  return `${pick(NAME_PREFIX)}${pick(NAME_STEM)}${used.size}${pick(NAME_SUFFIX)}`;
};

/** 町名を持たない旧セーブのための、番号から決まる名前。 */
export function fallbackTownName(index: number): string {
  const prefix = NAME_PREFIX[index % NAME_PREFIX.length];
  const stem = NAME_STEM[Math.floor(index / NAME_PREFIX.length) % NAME_STEM.length];
  return `${prefix}${stem}町`;
}

/**
 * 町の鉄道アクセスの良さ(0〜1)。
 *
 * 「その町の近くにあり、かつ実際に列車が停まる駅」からの近さを合計する。
 * 駅があっても列車が来なければ0 ── 線路を引いただけでは町は育たない。
 */
export function townServiceLevel(
  town: TownData,
  stations: Map<string, StationData>,
  servedStationIds: Set<string>
): number {
  let level = 0;
  for (const station of stations.values()) {
    if (!servedStationIds.has(station.id)) continue;
    const dist = Math.hypot(station.center.x - town.centre.x, station.center.z - town.centre.z);
    level += Math.max(0, 1 - dist / TOWN_STATION_RADIUS);
  }
  return Math.min(1, level);
}

/**
 * 1ヶ月ぶんの人口成長。鉄道アクセスが無い(serviceLevel=0)町は横ばい。
 * 人口は常に整数に保つ(表示と需要計算で端数を扱わないため)。
 */
export function growTown(town: TownData, serviceLevel: number): TownData {
  const rate = TOWN_GROWTH_RATE_MAX * Math.max(0, Math.min(1, serviceLevel));
  if (rate <= 0) return town;
  const grown = Math.min(TOWN_POPULATION_CAP, Math.round(town.population * (1 + rate)));
  if (grown === town.population) return town;
  return { ...town, population: grown };
}

// マップ上に人口を持つ街を生成する。中心座標は rejection sampling で
// 最低 TOWN_MIN_DISTANCE 離すよう決定的に配置する。
export function generateTowns(
  rng: () => number,
  count = 8,
  terrain: Map<string, TerrainType> = new Map()
): TownData[] {
  const towns: TownData[] = [];
  const usedNames = new Set<string>();

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
        const name = nextTownName(rng, usedNames);
        usedNames.add(name);
        towns.push({ id: `town-${i}`, name, centre: { x, z }, population });
        break;
      }
    }
  }

  return towns;
}
