// 街(town)の生成ロジック。純粋関数のみ。React/THREE には依存しない。
import type { CellData, StationData, TerrainType, TownData } from '../types';
import { toKey } from '../utils';
import { terrainAt } from './terrain';
import { cellOccupiesGround } from './townTiles';

type Pos = { x: number; z: number };

export const TOWN_COORD_RANGE = 40; // 中心座標は -40..40
// 街同士の最低距離(タイル)。町タイルの最大半径(townTiles.ts、16)まで成長した
// 大都市が隣町を丸ごと飲み込まないよう、旧値12から引き上げた(重なり自体は
// buildTownIndexesの先勝ちoccupied索引が防ぐが、間隔を空けたほうが見た目がよい)。
export const TOWN_MIN_DISTANCE = 16;
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
// 標高地形の導入で水域・山岳セルは数千個規模になったため、terrain全走査ではなく
// 候補の周囲O(radius^2)セルの直接参照で判定する(rejection samplingの試行×500に耐える)。
const isNearTerrain = (
  x: number,
  z: number,
  terrain: Map<string, TerrainType>,
  radius: number
): boolean => {
  const r = Math.ceil(radius);
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (Math.hypot(dx, dz) > radius) continue;
      if (terrain.has(toKey(x + dx, z + dz))) return true;
    }
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
export const nextTownName = (rng: () => number, used: Set<string>): string => {
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

// --- 駅名の町名採用 ---

/** 町名末尾の「町」「市」「村」を落とす(駅名は「南宮市」→「南宮駅」のように使う)。 */
const stripTownSuffix = (name: string): string => name.replace(/[町市村]$/, '');

// 被り対策で試す接尾語(方角の次、「〜中央」「新〜」の次に試す)。
const NAME_FALLBACK_SUFFIXES = ['台', '森', '谷', '浜', '橋'] as const;

/**
 * pos から半径 radius(既定は TOWN_STATION_RADIUS)以内で最も近い町を探す。
 * 見つからなければ null(=駅名は町名由来にできない)。
 */
export function nearestTownWithinRadius(
  pos: Pos,
  towns: TownData[],
  radius: number = TOWN_STATION_RADIUS
): TownData | null {
  let best: TownData | null = null;
  let bestDist = Infinity;
  for (const town of towns) {
    const dist = Math.hypot(town.centre.x - pos.x, town.centre.z - pos.z);
    if (dist <= radius && dist < bestDist) {
      best = town;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * 町の名前から駅名を1つ決める(TTD流の被り対策つき)。
 * 順に: 町名そのまま → 方角つき(町の中心から見た駅の方角、最も強い1方向) →
 * 「〜中央」→「新〜」→「〜台/森/谷/浜/橋」→ それでも埋まっていたら「〜第N」。
 * usedNames に無い最初の候補を返すため、必ず一意な名前になる。
 */
export function stationNameForTown(town: TownData, pos: Pos, usedNames: Set<string>): string {
  const base = stripTownSuffix(town.name);
  const dx = pos.x - town.centre.x;
  const dz = pos.z - town.centre.z;
  // 最も強い方角ひとつだけを使う(東西と南北が拮抗する場合は東西を優先)。
  const direction = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? '東' : '西') : dz < 0 ? '北' : '南';

  const candidates = [
    `${base}駅`,
    `${direction}${base}駅`,
    `${base}中央駅`,
    `新${base}駅`,
    ...NAME_FALLBACK_SUFFIXES.map(suffix => `${base}${suffix}駅`),
  ];
  for (const name of candidates) {
    if (!usedNames.has(name)) return name;
  }

  let n = 2;
  while (usedNames.has(`${base}第${n}駅`)) n++;
  return `${base}第${n}駅`;
}

// --- 輸送力に応じて町が発生する仕組み ---
//
// 旧仕様(駅を置いた瞬間に一定確率で即湧き)は「適当に駅を置いただけで町が湧く」
// という違和感の原因になっていたため廃止した。代わりに、実際にその駅へ列車が
// 停まるようになり、輸送力(停車する列車の定員合計)が一定以上になって初めて
// 町が育つ芽(小さな新しい町)が生える。判定は in-game 日次ティックで行う
// (stepWorldから呼ばれるresolveTownSpawnTick)。

// 新しい町は駅からこの距離(タイル)の範囲に生まれる。
const NEW_TOWN_SPAWN_RADIUS_MIN = 1;
const NEW_TOWN_SPAWN_RADIUS_MAX = 3;
export const NEW_TOWN_POPULATION_MIN = 100;
export const NEW_TOWN_POPULATION_MAX = 400;

/**
 * pos の周辺(1〜3タイル、水域・山岳を除く平地)から町の中心候補を1つ選び、
 * 新しい町を生成する(呼び出し側は既に「生やしてよい」と判定済みの前提)。
 * 候補が無ければnull。rngは呼び出し側から注入する。
 * railMapを渡すと、地面を占有する線路セル(線路・駅・車庫・坂)の上には町の中心を
 * 置かない(町の中心は道路タイルになるため。sim/townTiles.ts参照)。
 */
const spawnTownNear = (
  pos: Pos,
  towns: TownData[],
  terrain: Map<string, TerrainType>,
  rng: () => number,
  railMap?: Map<string, CellData>
): TownData | null => {
  const candidates: Pos[] = [];
  for (let dz = -NEW_TOWN_SPAWN_RADIUS_MAX; dz <= NEW_TOWN_SPAWN_RADIUS_MAX; dz++) {
    for (let dx = -NEW_TOWN_SPAWN_RADIUS_MAX; dx <= NEW_TOWN_SPAWN_RADIUS_MAX; dx++) {
      const dist = Math.hypot(dx, dz);
      if (dist < NEW_TOWN_SPAWN_RADIUS_MIN || dist > NEW_TOWN_SPAWN_RADIUS_MAX) continue;
      const x = pos.x + dx;
      const z = pos.z + dz;
      if (terrainAt(terrain, x, z) !== 'grass') continue;
      if (railMap && cellOccupiesGround(railMap.get(toKey(x, z)))) continue;
      candidates.push({ x, z });
    }
  }
  if (candidates.length === 0) return null;

  const centre = candidates[Math.floor(rng() * candidates.length)];
  const usedNames = new Set(towns.map(t => t.name));
  const name = nextTownName(rng, usedNames);
  const population = Math.round(
    NEW_TOWN_POPULATION_MIN + rng() * (NEW_TOWN_POPULATION_MAX - NEW_TOWN_POPULATION_MIN)
  );

  return { id: `town-spawn-${pos.x}-${pos.z}`, name, centre, population };
};

/**
 * 駅1つぶんの「その駅に停まる運行の輸送力」。呼び出し側(simulation.ts)が
 * 列車の運行表・編成両数から集計して渡す(towns.tsはtrains/groupsの形を知らない)。
 */
export interface StationTransportInfo {
  stationId: string;
  pos: Pos;
  /** その駅に停車する運行を持つ列車の編成容量(定員)の合計。 */
  capacity: number;
}

/** この輸送力(定員合計)に達すると、日次チェックでTOWN_SPAWN_BASE_CHANCEの確率で町が湧き始める。 */
export const TOWN_SPAWN_CAPACITY_THRESHOLD = 100;
/** 輸送力がちょうどTOWN_SPAWN_CAPACITY_THRESHOLDのときの、日次チェック1回あたりの湧き確率。 */
export const TOWN_SPAWN_BASE_CHANCE = 0.05;

/** 駅の輸送力から、日次チェック1回あたりの町の湧き確率を求める(単純な線形、1で頭打ち)。 */
export function townSpawnChance(capacity: number): number {
  if (capacity < TOWN_SPAWN_CAPACITY_THRESHOLD) return 0;
  return Math.min(1, TOWN_SPAWN_BASE_CHANCE * (capacity / TOWN_SPAWN_CAPACITY_THRESHOLD));
}

export interface TownSpawnTickResult {
  /** 町が1つでも湧けば新しい配列、湧かなければ引数のtownsをそのまま返す(参照が変わらない)。 */
  towns: TownData[];
  /** 今回のチェックで新たに湧いた町の一覧(湧かなければ空配列)。 */
  spawnedTowns: TownData[];
}

/**
 * 日次ティックで呼ぶ、輸送力に応じた町の湧き判定。
 *
 * stationInfos の各駅について、(1) 近くに既存の町が無く、(2) 輸送力が
 * TOWN_SPAWN_CAPACITY_THRESHOLD以上なら、townSpawnChanceの確率で新しい町を生やす。
 * 同一tick内で先に湧いた町も後続の駅の「近くに町が無いか」判定に反映する
 * (隣接する複数駅で同時に何個も湧かないように)。
 */
export function resolveTownSpawnTick(
  stationInfos: StationTransportInfo[],
  towns: TownData[],
  terrain: Map<string, TerrainType>,
  rng: () => number,
  // 既存の線路網(省略可)。町の中心を線路・駅・車庫の上に置かないために使う。
  railMap?: Map<string, CellData>
): TownSpawnTickResult {
  let currentTowns = towns;
  const spawnedTowns: TownData[] = [];

  for (const info of stationInfos) {
    if (info.capacity < TOWN_SPAWN_CAPACITY_THRESHOLD) continue;
    if (nearestTownWithinRadius(info.pos, currentTowns, TOWN_STATION_RADIUS)) continue;
    if (rng() >= townSpawnChance(info.capacity)) continue;

    const spawned = spawnTownNear(info.pos, currentTowns, terrain, rng, railMap);
    if (!spawned) continue;
    currentTowns = [...currentTowns, spawned];
    spawnedTowns.push(spawned);
  }

  return {
    towns: spawnedTowns.length > 0 ? currentTowns : towns,
    spawnedTowns,
  };
}
