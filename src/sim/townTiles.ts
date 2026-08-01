// タイルベースの町(道路・家)の決定的生成。純粋関数のみ。React/THREE には依存しない。
//
// 設計方針(progress/tile-based-towns.md参照):
// - タイル配置は町のid・人口・地形だけから決定的に再生成する(セーブデータには保存しない)。
//   人口が増えると半径・家の数が増え、町が視覚的に成長する。
// - 道路は町の中心を通る3タイル間隔の格子(OpenTTD風)。中心から4近傍で辿れる
//   道路タイルだけを採用する(水域などで分断された飛び地の道路は作らない)。
// - 家は「採用された道路タイルに4近傍で隣接する平地」から、中心に近い順に
//   人口ぶんだけ選ぶ。
// - 線路との関係:
//   * 家は地平の線路・駅・車庫・坂セルには絶対に生成しない(建設側のガードと対で、
//     家と地平線路は決して同居しない)。
//   * 道路は素の線路(type 'rail'、坂を除く)との同居を許す=踏切になる。既存の駅・
//     車庫・坂セルには道路も作らない。
//   * 純粋な高架専用セル(地平のconnectionsが無くuppersのみ)は地面を塞がないため、
//     家・道路とも同居できる(高架は町の上を通過できる)。
// - 複数の町が近接する場合は、buildTownTileIndexが towns 配列の順(先勝ち)で
//   タイルの所有を決める。
import type { CellData, TerrainType, TownData } from '../types';
import { toKey } from '../utils';
import { terrainAt } from './terrain';

export type TownTileKind = 'house' | 'road';

export interface TownTileEntry {
  townId: string;
  kind: TownTileKind;
}

/** 全町を合成した「セルキー→(町id, タイル種別)」の索引。 */
export type TownTileIndex = Map<string, TownTileEntry>;

/** 道路格子の間隔(タイル)。OpenTTDの2x2/3x3レイアウトに倣い3を採用。 */
export const TOWN_ROAD_GRID_SPACING = 3;
/** 町タイルの最大半径(チェビシェフ距離)。TOWN_MIN_DISTANCE=12と重なりすぎない値。 */
export const TOWN_TILE_RADIUS_MAX = 7;

/** 人口から町タイルの半径(チェビシェフ距離)を決める。人口が増えると広がる。 */
export const townTileRadius = (population: number): number =>
  Math.min(TOWN_TILE_RADIUS_MAX, 2 + Math.floor(Math.sqrt(Math.max(0, population) / 800)));

/** 人口から家タイルの目標数を決める(候補が足りなければ候補数まで)。 */
export const townHouseTarget = (population: number): number =>
  Math.max(5, Math.round(Math.max(0, population) / 300));

// 町のidから決定的な数値シードを作る(文字列ハッシュ)。旧TownBlocks.tsxから移設。
export const seedFromId = (id: string): number => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (Math.imul(31, hash) + id.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
};

// (seed, x, z) からの決定的ハッシュ(0..1)。逐次消費するrngと違い走査順に依存しない。
const tileHash = (seed: number, x: number, z: number): number => {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

/** セルが地面(地平レベル)を占有しているか。純粋な高架専用セルはfalse。 */
export const cellOccupiesGround = (cell: CellData | undefined): boolean => {
  if (!cell) return false;
  if (cell.type === 'station' || cell.type === 'depot') return true;
  if (cell.ramp) return true;
  return (cell.connections ?? 0) !== 0;
};

// 道路タイルとの同居を許す線路セルか(素の地平線路のみ=踏切)。駅・車庫・坂は不可。
const cellAllowsRoadCrossing = (cell: CellData | undefined): boolean => {
  if (!cell) return true;
  if (cell.type === 'station' || cell.type === 'depot') return false;
  if (cell.ramp) return false;
  return true; // type 'rail'(高架のみのセル含む)は踏切として同居できる
};

export interface TownTileOptions {
  /** 他の町のタイルなど、道路・家のどちらも置けないセルキーの集合。 */
  occupied?: Set<string>;
  /** 既存の線路網。家は地面を占有するセルを避け、道路は素の線路のみ許す(踏切)。 */
  railMap?: Map<string, CellData>;
}

const NEIGHBOURS_4: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 1つの町のタイル配置(セルキー→'house'|'road')を決定的に生成する。
 * 町の中心が平地でない(理論上は起きない)場合は空マップを返す。
 */
export function generateTownTiles(
  town: TownData,
  terrain: Map<string, TerrainType>,
  heights: Map<string, number> = new Map(),
  options: TownTileOptions = {}
): Map<string, TownTileKind> {
  const occupied = options.occupied ?? new Set<string>();
  const railMap = options.railMap;
  const seed = seedFromId(town.id);
  const radius = townTileRadius(town.population);
  const cx = town.centre.x;
  const cz = town.centre.z;

  // 平地(標高0の草地)かどうか。mountainは標高1以上なので実質terrain判定で足りるが、
  // heightsが一次データである以上、両方を明示的に確認しておく。
  const isFlatGrass = (x: number, z: number): boolean =>
    terrainAt(terrain, x, z) === 'grass' && (heights.get(toKey(x, z)) ?? 0) === 0;

  const roadPlaceable = (x: number, z: number): boolean =>
    Math.abs(x - cx) <= radius &&
    Math.abs(z - cz) <= radius &&
    ((x - cx) % TOWN_ROAD_GRID_SPACING === 0 || (z - cz) % TOWN_ROAD_GRID_SPACING === 0) &&
    isFlatGrass(x, z) &&
    !occupied.has(toKey(x, z)) &&
    cellAllowsRoadCrossing(railMap?.get(toKey(x, z)));

  const tiles = new Map<string, TownTileKind>();
  if (!roadPlaceable(cx, cz)) return tiles;

  // 中心から4近傍で辿れる道路タイルだけを採用する(飛び地の道路を作らない)。
  const roadKeys = new Set<string>([toKey(cx, cz)]);
  const queue: Array<{ x: number; z: number }> = [{ x: cx, z: cz }];
  while (queue.length > 0) {
    const p = queue.shift()!;
    for (const [dx, dz] of NEIGHBOURS_4) {
      const nx = p.x + dx;
      const nz = p.z + dz;
      const nKey = toKey(nx, nz);
      if (roadKeys.has(nKey)) continue;
      if (!roadPlaceable(nx, nz)) continue;
      roadKeys.add(nKey);
      queue.push({ x: nx, z: nz });
    }
  }
  for (const key of roadKeys) tiles.set(key, 'road');

  // 家の候補: 採用済み道路タイルに4近傍で隣接する、地面が空いた平地。
  // 中心に近い順(同距離はセルハッシュ順)に人口ぶん選ぶことで、人口増加時は
  // 既存の家を保ったまま外側へ広がる。
  const housePlaceable = (x: number, z: number): boolean =>
    isFlatGrass(x, z) &&
    !occupied.has(toKey(x, z)) &&
    !cellOccupiesGround(railMap?.get(toKey(x, z)));

  const candidates: Array<{ x: number; z: number; order: number }> = [];
  for (let x = cx - radius; x <= cx + radius; x++) {
    for (let z = cz - radius; z <= cz + radius; z++) {
      const key = toKey(x, z);
      if (roadKeys.has(key)) continue;
      if (!housePlaceable(x, z)) continue;
      const adjacentToRoad = NEIGHBOURS_4.some(([dx, dz]) => roadKeys.has(toKey(x + dx, z + dz)));
      if (!adjacentToRoad) continue;
      const dist = Math.hypot(x - cx, z - cz);
      candidates.push({ x, z, order: dist + tileHash(seed, x, z) * 0.9 });
    }
  }
  candidates.sort((a, b) => a.order - b.order);

  const target = Math.min(candidates.length, townHouseTarget(town.population));
  for (let i = 0; i < target; i++) {
    tiles.set(toKey(candidates[i].x, candidates[i].z), 'house');
  }

  return tiles;
}

/**
 * 全町のタイルを合成した索引を作る。towns配列の順に生成し、先の町が確保した
 * セルは後の町から見て occupied になる(先勝ち)。
 * railMapを渡すと、家は地面を占有する線路セルを避ける(描画と建設ガードで同じ
 * railMapを渡せば、家と地平線路が重なることはない)。
 */
export function buildTownTileIndex(
  towns: TownData[],
  terrain: Map<string, TerrainType>,
  heights: Map<string, number> = new Map(),
  railMap?: Map<string, CellData>
): TownTileIndex {
  const index: TownTileIndex = new Map();
  const occupied = new Set<string>();
  for (const town of towns) {
    const tiles = generateTownTiles(town, terrain, heights, { occupied, railMap });
    for (const [key, kind] of tiles) {
      index.set(key, { townId: town.id, kind });
      occupied.add(key);
    }
  }
  return index;
}

/** セル(x,z)の町タイル(あれば)。 */
export const townTileAt = (index: TownTileIndex, x: number, z: number): TownTileEntry | undefined =>
  index.get(toKey(x, z));

/** 地平の建設(線路など)を遮る町タイルか。家のみtrue(道路は踏切として通過可)。 */
export const isTownBlocked = (index: TownTileIndex, x: number, z: number): boolean =>
  index.get(toKey(x, z))?.kind === 'house';
