// タイルベースの町(道路・家)の決定的生成。純粋関数のみ。React/THREE には依存しない。
//
// 設計方針(progress/tile-based-towns.md参照):
// - タイル配置は町のid・人口・地形だけから決定的に再生成する(セーブデータには保存しない)。
//   人口が増えると半径・家の数が増え、町が視覚的に成長する。
// - レイアウトは1ゲームタイルを2x2に分割した「サブタイル」粒度で決める。
//   道路は幅1サブタイル(=半タイル幅)の帯、家は1サブタイルに1軒。線路のタイルと
//   比べて道路が明確に細くなり、スケール感が合う。
// - 道路はサブタイル格子(TOWN_ROAD_SUB_SPACING間隔)のOpenTTD風レイアウト。中心から
//   4近傍で辿れる道路サブタイルだけを採用する(飛び地の道路は作らない)。
// - 家は「採用された道路サブタイルに4近傍で隣接するサブタイル」から、中心に近い順に
//   人口ぶんだけ選ぶ。
// - 家の配置後、家からチェビシェフ距離TOWN_ROAD_PRUNE_DISTANCE以内に無い道路サブタイル
//   を刈り込む(中心へのBFS木経路上の道路は連結性のため残す)。空の道路格子が
//   集落の外へ放射状に突き出ない。
// - 適地判定(水域・山岳・標高・他町・線路)は親ゲームタイル単位で行う。線路の衝突
//   判定はタイルベースなので、それより細かい粒度に意味はない。
// - 線路との関係(親タイル単位):
//   * 家は地平の線路・駅・車庫・坂セルには絶対に生成しない(建設側のガードと対で、
//     家と地平線路は決して同居しない)。
//   * 道路は素の線路(type 'rail'、坂を除く)との同居を許す=踏切になる。既存の駅・
//     車庫・坂セルには道路も作らない。
//   * 純粋な高架専用セル(地平のconnectionsが無くuppersのみ)は地面を塞がないため、
//     家・道路とも同居できる(高架は町の上を通過できる)。
// - 建設ガードが参照するタイル粒度の索引は、サブタイルから導出する:
//   タイル内に家サブタイルが1つでもあれば 'house'(地平線路を遮る)、道路サブタイル
//   のみなら 'road'(踏切として通過可)。
// - 複数の町が近接する場合は、buildTownTileIndexが towns 配列の順(先勝ち)で
//   タイル(親タイル単位)の所有を決める。
import type { CellData, TownData } from '../types';
import { toKey, fromKey } from '../utils';
import type { TerrainField } from './terrainField';

export type TownTileKind = 'house' | 'road';

export interface TownTileEntry {
  townId: string;
  kind: TownTileKind;
}

/**
 * タイル粒度の索引が満たすべき最小のインターフェース(P5)。既存の消費側
 * (construction.ts/buildPreview.ts/GameUI.tsx/Scenery.tsx)はすべて`.has(key)`/
 * `.get(key)`(toKeyで作った文字列キー)だけを使い、走査(for..of/values())はしない。
 * `Map<string, TownTileEntry>`は構造的にこのインターフェースを満たすため、
 * buildTownIndexesの戻り値(旧来の全町eagerな索引)とTownTileCache(下記、
 * 町ごとの遅延キャッシュ)のどちらを渡しても既存コードは無変更で動く。
 */
export interface TownTileIndex {
  has(key: string): boolean;
  get(key: string): TownTileEntry | undefined;
}

/** 全町を合成した「サブタイルキー→(町id, 種別)」のサブタイル粒度の索引(描画用)。 */
export type TownSubTileIndex = Map<string, TownTileEntry>;

/** 1ゲームタイルの一辺あたりのサブタイル数(2x2分割)。 */
export const SUB_TILES_PER_TILE = 2;
/** 道路格子の間隔(サブタイル)。5=2.5タイルで、格子の間に2x2タイル分の街区ができる。 */
export const TOWN_ROAD_SUB_SPACING = 5;
/**
 * 町タイルの最大半径(タイル、チェビシェフ距離)。人口上限(TOWN_POPULATION_CAP=50000)の
 * 直前(約47000人)で初めて到達する値にし、成長が上限近くまで見た目に反映されるようにする。
 * 隣接する町とはTOWN_MIN_DISTANCE(towns.ts、16)+先勝ちのoccupied索引で棲み分ける。
 */
export const TOWN_TILE_RADIUS_MAX = 16;
/** 町サブタイルの最大半径(サブタイル、チェビシェフ距離)。 */
export const TOWN_SUB_TILE_RADIUS_MAX = TOWN_TILE_RADIUS_MAX * 2 + 1;
/** 道路の刈り込み距離(サブタイル、チェビシェフ)。家からこの距離を超える道路は落とす。 */
export const TOWN_ROAD_PRUNE_DISTANCE = 2;

/**
 * 人口から町タイルの半径(タイル、チェビシェフ距離)を決める。人口が増えると広がる。
 * 500人≈半径2、5000人≈6、20000人≈10、50000人(人口上限)=16。飽和は約47000人と
 * 上限直前なので、成長のほぼ全域で町が視覚的に大きくなり続ける。
 */
export const TOWN_TILE_RADIUS_MAX_POPULATION = 210; // radius = 1 + floor(sqrt(pop/この値))
export const townTileRadius = (population: number): number =>
  Math.min(
    TOWN_TILE_RADIUS_MAX,
    1 + Math.floor(Math.sqrt(Math.max(0, population) / TOWN_TILE_RADIUS_MAX_POPULATION))
  );

/** 人口から町の半径(サブタイル)を決める。タイル半径の約2倍。 */
export const townSubTileRadius = (population: number): number =>
  Math.min(TOWN_SUB_TILE_RADIUS_MAX, SUB_TILES_PER_TILE * townTileRadius(population) + 1);

/**
 * 人口から家サブタイルの目標数を決める(候補が足りなければ候補数まで)。
 * 50000人で約1000軒になり、拡大した半径(最大16タイル)の街区を密に埋める。
 */
export const townHouseTarget = (population: number): number =>
  Math.max(20, Math.round(Math.max(0, population) / 50));

/** サブタイル座標→親ゲームタイル座標。sx = 2x + i (i∈{0,1})。負数もfloorで正しく戻る。 */
export const parentTileOfSub = (s: number): number => Math.floor(s / SUB_TILES_PER_TILE);

/** サブタイル座標→ワールド座標(サブタイル中央)。1タイルは x±0.5 に広がる。 */
export const subTileWorldCentre = (s: number): number => s * 0.5 - 0.25;

// 町のidから決定的な数値シードを作る(文字列ハッシュ)。旧TownBlocks.tsxから移設。
export const seedFromId = (id: string): number => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (Math.imul(31, hash) + id.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
};

// (seed, sx, sz) からの決定的ハッシュ(0..1)。逐次消費するrngと違い走査順に依存しない。
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
  /** 他の町のタイルなど、道路・家のどちらも置けない親タイルのセルキーの集合。 */
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
 * 1つの町のサブタイル配置(サブタイルキー→'house'|'road')を決定的に生成する。
 * サブタイル座標は sx = 2x + i, sz = 2z + j (i,j∈{0,1})。
 * 町の中心が平地でない(理論上は起きない)場合は空マップを返す。
 */
export function generateTownSubTiles(
  town: TownData,
  field: TerrainField,
  options: TownTileOptions = {}
): Map<string, TownTileKind> {
  const occupied = options.occupied ?? new Set<string>();
  const railMap = options.railMap;
  const seed = seedFromId(town.id);
  const subRadius = townSubTileRadius(town.population);
  // 中心サブタイル: 中心タイルの北西側サブタイル(2cx, 2cz)。
  const scx = town.centre.x * SUB_TILES_PER_TILE;
  const scz = town.centre.z * SUB_TILES_PER_TILE;

  // 親タイルが平地(標高0の草地)かどうか。
  const isFlatGrass = (x: number, z: number): boolean => field.terrainTypeAt(x, z) === 'grass';

  // 親タイル単位の適地判定(道路用/家用)。線路衝突がタイルベースなので粒度もタイル。
  const parentAllowsRoad = (sx: number, sz: number): boolean => {
    const px = parentTileOfSub(sx);
    const pz = parentTileOfSub(sz);
    return (
      isFlatGrass(px, pz) &&
      !occupied.has(toKey(px, pz)) &&
      cellAllowsRoadCrossing(railMap?.get(toKey(px, pz)))
    );
  };
  const parentAllowsHouse = (sx: number, sz: number): boolean => {
    const px = parentTileOfSub(sx);
    const pz = parentTileOfSub(sz);
    return (
      isFlatGrass(px, pz) &&
      !occupied.has(toKey(px, pz)) &&
      !cellOccupiesGround(railMap?.get(toKey(px, pz)))
    );
  };

  const roadPlaceable = (sx: number, sz: number): boolean =>
    Math.abs(sx - scx) <= subRadius &&
    Math.abs(sz - scz) <= subRadius &&
    ((sx - scx) % TOWN_ROAD_SUB_SPACING === 0 || (sz - scz) % TOWN_ROAD_SUB_SPACING === 0) &&
    parentAllowsRoad(sx, sz);

  const subTiles = new Map<string, TownTileKind>();
  if (!roadPlaceable(scx, scz)) return subTiles;

  const centreKey = toKey(scx, scz);

  // 中心から4近傍で辿れる道路サブタイルだけを採用する(飛び地の道路を作らない)。
  // BFS木の親を記録しておき、あとの刈り込みで「中心への接続経路」を残すのに使う。
  // 訪問順は固定(FIFO+固定近傍順)なので親も決定的。
  const roadKeys = new Set<string>([centreKey]);
  const roadParent = new Map<string, string>();
  const queue: Array<{ x: number; z: number }> = [{ x: scx, z: scz }];
  while (queue.length > 0) {
    const p = queue.shift()!;
    for (const [dx, dz] of NEIGHBOURS_4) {
      const nx = p.x + dx;
      const nz = p.z + dz;
      const nKey = toKey(nx, nz);
      if (roadKeys.has(nKey)) continue;
      if (!roadPlaceable(nx, nz)) continue;
      roadKeys.add(nKey);
      roadParent.set(nKey, toKey(p.x, p.z));
      queue.push({ x: nx, z: nz });
    }
  }

  // 家の候補: 採用済み道路サブタイルに4近傍で隣接する、地面が空いたサブタイル。
  // 中心に近い順(同距離はサブタイルハッシュ順)に人口ぶん選ぶことで、人口増加時は
  // 既存の家を保ったまま外側へ広がる。
  const candidates: Array<{ sx: number; sz: number; order: number }> = [];
  for (let sx = scx - subRadius; sx <= scx + subRadius; sx++) {
    for (let sz = scz - subRadius; sz <= scz + subRadius; sz++) {
      const key = toKey(sx, sz);
      if (roadKeys.has(key)) continue;
      if (!parentAllowsHouse(sx, sz)) continue;
      const adjacentToRoad = NEIGHBOURS_4.some(([dx, dz]) => roadKeys.has(toKey(sx + dx, sz + dz)));
      if (!adjacentToRoad) continue;
      const dist = Math.hypot(sx - scx, sz - scz);
      candidates.push({ sx, sz, order: dist + tileHash(seed, sx, sz) * 0.9 });
    }
  }
  candidates.sort((a, b) => a.order - b.order);

  const target = Math.min(candidates.length, townHouseTarget(town.population));
  const houses = candidates.slice(0, target);

  // 道路の刈り込み: 家の集落から離れた空の道路格子(人口が少ない町で半径いっぱいに
  // 伸びる十字)を落とす。家からチェビシェフ距離TOWN_ROAD_PRUNE_DISTANCE以内の道路
  // を残し、それぞれについてBFS木の親を中心まで辿った経路も残す(連結性の保証)。
  // 家の隣の道路は距離1なので必ず残り、家の道路隣接は崩れない。
  const keptRoads = new Set<string>([centreKey]);
  const keepWithPathToCentre = (key: string): void => {
    let current: string | undefined = key;
    while (current !== undefined && !keptRoads.has(current)) {
      keptRoads.add(current);
      current = roadParent.get(current);
    }
  };
  for (const { sx, sz } of houses) {
    for (let dx = -TOWN_ROAD_PRUNE_DISTANCE; dx <= TOWN_ROAD_PRUNE_DISTANCE; dx++) {
      for (let dz = -TOWN_ROAD_PRUNE_DISTANCE; dz <= TOWN_ROAD_PRUNE_DISTANCE; dz++) {
        const key = toKey(sx + dx, sz + dz);
        if (roadKeys.has(key)) keepWithPathToCentre(key);
      }
    }
  }

  for (const key of keptRoads) subTiles.set(key, 'road');
  for (const { sx, sz } of houses) {
    subTiles.set(toKey(sx, sz), 'house');
  }

  return subTiles;
}

/**
 * サブタイル配置からタイル粒度の種別を導出する。タイル内に家サブタイルが1つでも
 * あれば 'house'(地平線路を遮る)、道路サブタイルのみなら 'road'(踏切可)。
 */
export function deriveTileKinds(subTiles: Map<string, TownTileKind>): Map<string, TownTileKind> {
  const tiles = new Map<string, TownTileKind>();
  for (const [key, kind] of subTiles) {
    const { x: sx, z: sz } = fromKey(key);
    const parentKey = toKey(parentTileOfSub(sx), parentTileOfSub(sz));
    if (kind === 'house') {
      tiles.set(parentKey, 'house');
    } else if (tiles.get(parentKey) !== 'house') {
      tiles.set(parentKey, 'road');
    }
  }
  return tiles;
}

/**
 * 1つの町のタイル粒度の配置(セルキー→'house'|'road')を決定的に生成する。
 * サブタイル生成(generateTownSubTiles)から導出する。建設ガード互換のための公開API。
 */
export function generateTownTiles(
  town: TownData,
  field: TerrainField,
  options: TownTileOptions = {}
): Map<string, TownTileKind> {
  return deriveTileKinds(generateTownSubTiles(town, field, options));
}

export interface TownIndexes {
  /** タイル粒度の索引(建設ガード・地形編集・樹木の間引きに使う)。 */
  tiles: TownTileIndex;
  /** サブタイル粒度の索引(描画に使う)。 */
  subTiles: TownSubTileIndex;
}

/**
 * 全町のタイル・サブタイル索引を合成して作る。towns配列の順に生成し、先の町が
 * 確保した親タイルは後の町から見て occupied になる(先勝ち)。
 * railMapを渡すと、家は地面を占有する線路セルを避ける(描画と建設ガードで同じ
 * railMapを渡せば、家と地平線路が重なることはない)。
 */
export function buildTownIndexes(
  towns: TownData[],
  field: TerrainField,
  railMap?: Map<string, CellData>
): TownIndexes {
  const tiles: TownTileIndex = new Map();
  const subTiles: TownSubTileIndex = new Map();
  const occupied = new Set<string>();
  for (const town of towns) {
    const subs = generateTownSubTiles(town, field, { occupied, railMap });
    for (const [key, kind] of subs) {
      subTiles.set(key, { townId: town.id, kind });
    }
    for (const [key, kind] of deriveTileKinds(subs)) {
      tiles.set(key, { townId: town.id, kind });
      occupied.add(key);
    }
  }
  return { tiles, subTiles };
}

/** 全町を合成したタイル粒度の索引を作る(buildTownIndexesのタイル側のみ)。 */
export function buildTownTileIndex(
  towns: TownData[],
  field: TerrainField,
  railMap?: Map<string, CellData>
): TownTileIndex {
  return buildTownIndexes(towns, field, railMap).tiles;
}

/** セル(x,z)の町タイル(あれば)。 */
export const townTileAt = (index: TownTileIndex, x: number, z: number): TownTileEntry | undefined =>
  index.get(toKey(x, z));

/** 地平の建設(線路など)を遮る町タイルか。家のみtrue(道路は踏切として通過可)。 */
export const isTownBlocked = (index: TownTileIndex, x: number, z: number): boolean =>
  index.get(toKey(x, z))?.kind === 'house';

// --- 町ごとの遅延タイルキャッシュ(P5, progress/16k-map-architecture.md参照) ---
//
// buildTownIndexesは全町を毎回eagerに再生成する(町ごとにO(radius^2)のBFS)ため、
// 16Kマップで町が数千個になると「railMapが1回変わるたびに全町再生成」というコストが
// 生まれる(たとえカメラがマップの隅にいて1つも見えていなくても)。TownTileCacheは
// これを「クエリされた町だけ、その町のrailMap参照が変わったときだけ」再生成する
// 遅延キャッシュに置き換える。
//
// 空間索引: 町の中心をCANDIDATE_BUCKET_SIZE四方のバケットへ割り当てる。町タイル半径の
// 最大値(TOWN_TILE_RADIUS_MAX=16)はバケット半分(32)より小さいので、セル(x,z)を含みうる
// 町は「(x,z)のバケット」を中心とした3x3バケットの範囲にしか存在し得ない。
const CANDIDATE_BUCKET_SIZE = 64;
const bucketCoordOf = (v: number): number => Math.floor(v / CANDIDATE_BUCKET_SIZE);
const bucketKeyOf = (bx: number, bz: number): string => `${bx},${bz}`;

interface TownTileCacheEntry {
  subTiles: Map<string, TownTileKind>;
  tiles: Map<string, TownTileKind>;
  /** このエントリを生成したときのrailMap参照。参照が変われば無効(再生成対象)。 */
  railMapRef: Map<string, CellData> | undefined;
}

/**
 * 町ごとに遅延生成・キャッシュするタイル索引。TownTileIndexインターフェース
 * (has/get)を実装するのでconstruction.ts/buildPreview.ts/GameUI.tsx/Scenery.tsxの
 * 既存コードにそのまま渡せる。加えて、可視町だけの描画用サブタイル索引を作る
 * subTilesForTownsを提供する(TownBlocks.tsxのチャンク化された描画から使う)。
 *
 * 無効化キー: 町ごとに「最後に使ったrailMap参照」を覚えておき、参照が変わって
 * いたら(=railMapへの何らかの編集が起きていたら)その町だけ再生成する。厳密には
 * 「その町のbboxに触れる編集だけ」に絞り込むのが理想だが、railMapの差分セル一覧を
 * 呼び出し側が持っていないため、この簡略版では「参照が変わっていれば再生成」に
 * している。ただし再生成は実際にクエリされた町についてだけ起きる(=遠くの町は
 * 何回railMapが変わっても、クエリされない限り再計算されない)ため、
 * 「全町を毎回舐める」という当初の問題は解消される。
 */
export class TownTileCache implements TownTileIndex {
  private readonly towns: TownData[];
  private readonly townById: Map<string, TownData>;
  private readonly field: TerrainField;
  private readonly railMap: Map<string, CellData> | undefined;
  private readonly buckets: Map<string, TownData[]> = new Map();
  private readonly cache: Map<string, TownTileCacheEntry> = new Map();

  constructor(towns: TownData[], field: TerrainField, railMap?: Map<string, CellData>) {
    this.towns = towns;
    this.field = field;
    this.railMap = railMap;
    this.townById = new Map(towns.map(t => [t.id, t]));
    for (const town of towns) {
      const bx = bucketCoordOf(town.centre.x);
      const bz = bucketCoordOf(town.centre.z);
      const key = bucketKeyOf(bx, bz);
      const list = this.buckets.get(key);
      if (list) list.push(town);
      else this.buckets.set(key, [town]);
    }
  }

  private candidatesFor(x: number, z: number): TownData[] {
    const bx = bucketCoordOf(x);
    const bz = bucketCoordOf(z);
    const out: TownData[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = this.buckets.get(bucketKeyOf(bx + dx, bz + dz));
        if (!list) continue;
        for (const town of list) {
          const r = townTileRadius(town.population);
          if (Math.abs(town.centre.x - x) <= r && Math.abs(town.centre.z - z) <= r) out.push(town);
        }
      }
    }
    return out;
  }

  /** 町ごとのタイル/サブタイルを取得(キャッシュヒットならそのまま、なければ生成)。 */
  private entryFor(town: TownData): TownTileCacheEntry {
    const cached = this.cache.get(town.id);
    if (cached && cached.railMapRef === this.railMap) return cached;
    const subTiles = generateTownSubTiles(town, this.field, { railMap: this.railMap });
    const entry: TownTileCacheEntry = {
      subTiles,
      tiles: deriveTileKinds(subTiles),
      railMapRef: this.railMap,
    };
    this.cache.set(town.id, entry);
    return entry;
  }

  /** セルキー(toKey形式)からタイル情報を取得。マップ全域のどのセルに対しても呼べる。 */
  get(key: string): TownTileEntry | undefined {
    const { x, z } = fromKey(key);
    // towns配列の順(先勝ち)で、実際にそのセルにタイルを持つ最初の町を採用する。
    for (const town of this.candidatesFor(x, z)) {
      const kind = this.entryFor(town).tiles.get(key);
      if (kind) return { townId: town.id, kind };
    }
    return undefined;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** 指定した町id群(可視町のみ等)のサブタイル索引を合成して返す(描画用)。 */
  subTilesForTowns(townIds: Iterable<string>): TownSubTileIndex {
    const merged: TownSubTileIndex = new Map();
    for (const id of townIds) {
      const town = this.townById.get(id);
      if (!town) continue;
      const entry = this.entryFor(town);
      for (const [key, kind] of entry.subTiles) {
        if (!merged.has(key)) merged.set(key, { townId: town.id, kind });
      }
    }
    return merged;
  }
}

/** 町のタイル粒度のbbox(セル座標)が、指定範囲(両端含む)と交差するか。描画の可視判定に使う。 */
export function townIntersectsCellRange(
  town: TownData,
  x0: number,
  x1: number,
  z0: number,
  z1: number
): boolean {
  const r = townTileRadius(town.population);
  return (
    town.centre.x + r >= x0 &&
    town.centre.x - r <= x1 &&
    town.centre.z + r >= z0 &&
    town.centre.z - r <= z1
  );
}
