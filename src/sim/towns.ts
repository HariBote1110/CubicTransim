// 街(town)の生成ロジック。純粋関数のみ。React/THREE には依存しない。
import type { CellData, StationData, TownData } from '../types';
import { toKey } from '../utils';
import type { TerrainField } from './terrainField';
import { cellOccupiesGround } from './townTiles';
import { slopeOf } from './slopes';

type Pos = { x: number; z: number };

export const TOWN_POPULATION_MIN = 500;
export const TOWN_POPULATION_MAX = 5000;
/** 人口の上限。鉄道が便利でもこれ以上は増えない。 */
export const TOWN_POPULATION_CAP = 50_000;
/** 鉄道アクセスが最良(serviceLevel=1)のときの月あたり人口増加率。 */
export const TOWN_GROWTH_RATE_MAX = 0.03;
/** 街の中心からこの距離(タイル)までの駅を「その町の駅」とみなす。 */
export const TOWN_STATION_RADIUS = 10;
export const TOWN_TERRAIN_AVOID_RADIUS = 3; // 水域からこの半径以内には街を生成しない
/**
 * 「平坦」とみなす最低割合(P7d)。以前は候補周辺に水域・山岳(=標高1以上)が
 * 1セルでもあれば棄却していたが、標高上の建設(slopes.ts)導入後は「山岳=建設不可」
 * ではなくなったため、町も平坦な高原(標高任意)に置けるようにする。ただし
 * 傾斜だらけの地形(incline/other)に町を置くと道路・家が生成できないセルだらけに
 * なるため、周辺セルのうち十分な割合がflat(slopeOf)であることは引き続き要求する。
 */
const TOWN_FLAT_MAJORITY_RATIO = 0.85;

// 候補座標が町の立地として不適か: (a)水域が半径radius以内にある、または
// (b)周辺セルのうちflat(slopeOf)である割合がTOWN_FLAT_MAJORITY_RATIO未満。
// 旧isNearTerrain(terrainTypeAt!=='grass'で1セルでも棄却)の置き換え。標高そのものは
// 問わない(標高1以上の平坦な台地も適地になる)。
//
// 水域判定は半径内の全セルをterrainTypeAtで走査する(従来通り、1セルでも水域なら
// 即棄却)。flat判定はcellCornerHeights呼び出し(=createTerrainFieldの実装では
// compositeNoiseを追加で4回叩く、terrainTypeAtとは別建てのコスト)を伴うため、
// 同じ密度で回すとrejection samplingの試行×16K領域規模で無視できないコストになる
// (実測: towns.test.tsの16Kマップ生成500msガードに抵触した)。flatの割合を知るのに
// 全セルを見る必要はないため、間引いた格子(2セルおき)でサンプリングして
// コストを抑える(半径3なら約13点で足り、統計的な「優勢かどうか」の判定には十分)。
const TOWN_FLAT_SAMPLE_STRIDE = 2;
const isNearTerrain = (
  x: number,
  z: number,
  field: TerrainField,
  radius: number
): boolean => {
  const r = Math.ceil(radius);
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (Math.hypot(dx, dz) > radius) continue;
      if (field.terrainTypeAt(x + dx, z + dz) === 'water') return true;
    }
  }

  let total = 0;
  let flat = 0;
  for (let dx = -r; dx <= r; dx += TOWN_FLAT_SAMPLE_STRIDE) {
    for (let dz = -r; dz <= r; dz += TOWN_FLAT_SAMPLE_STRIDE) {
      if (Math.hypot(dx, dz) > radius) continue;
      total++;
      if (slopeOf(field.cellCornerHeights(x + dx, z + dz)).kind === 'flat') flat++;
    }
  }
  return total > 0 && flat / total < TOWN_FLAT_MAJORITY_RATIO;
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

// --- 領域ベースの決定的な町配置(P5, progress/16k-map-architecture.md参照) ---
//
// 旧generateTowns(P6で削除)は「count個ループでrejection sampling」というグローバルな
// 手続きで、マップ全域を一度に見渡す必要があった。16Kマップ(halfExtent=8192)
// では成立しない(全域を一度に扱う前提が破綻する)ため、マップを128×128セルの領域
// (region)に分割し、各領域は(worldSeed, regionCoord)だけから独立に「町を1つ持つか・
// 持たないか」を決める。これにより「可視・近傍の領域だけ実体化する」将来の拡張や、
// O(regions)の新規ゲーム生成が可能になる。

/** 領域の一辺(セル)。この単位でマップを分割し、各領域が町候補を最大1つ持つ。 */
export const TOWN_REGION_SIZE = 128;
/**
 * 領域が町候補を持つ確率(地形による棄却より前のゲート)。16Kマップ(halfExtent=8192)は
 * 約129×129=16641領域に分割されるため、この確率で「a few thousand towns」
 * (設計メモの目標)になる。旧仕様の「91²マップに8個」と同じ密度(セルあたり)には
 * 領域サイズ128が91²マップ全体より大きいため原理的に一致させられない(1領域=町0か1個)。
 * 大きいマップでの体感密度を優先し、既定マップは町が少なめになる代わりに
 * resolveTownSpawnTick(輸送力に応じた町の湧き)が実プレイで補う設計とした。
 */
export const TOWN_REGION_DENSITY = 0.4;

export interface RegionCoord {
  rx: number;
  rz: number;
}

// (worldSeed, rx, rz, salt) からの決定的ハッシュ(0..1)。townTiles.tsのtileHashと同型。
const regionHash = (seed: number, rx: number, rz: number, salt: number): number => {
  let h =
    (seed ^ Math.imul(rx | 0, 0x27d4eb2d) ^ Math.imul(rz | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

// 領域専用のrng(mulberry32)。名前/人口の決定にはこちらを使う(逐次消費するが、
// 領域ごとに独立したシードから始まるので列挙順に依存しない=チャンク非依存)。
const regionRng = (seed: number, rx: number, rz: number): (() => number) => {
  const s =
    (Math.imul(seed ^ 0x9e3779b9, 1) ^ Math.imul(rx | 0, 0x27d4eb2d) ^ Math.imul(rz | 0, 0x165667b1)) >>> 0;
  return mulberry32(s);
};

/** 領域ベースの町のid("town-r{rx},{rz}")。ランタイム湧き(town-spawn-...)と衝突しない。 */
export const regionTownId = (rx: number, rz: number): string => `town-r${rx},${rz}`;

/** halfExtent(-halfExtent..halfExtent)と交差する領域座標を、rx昇順→rz昇順で列挙する。 */
export function regionsInRange(halfExtent: number): RegionCoord[] {
  const extent = Math.max(0, halfExtent);
  const rMin = Math.floor(-extent / TOWN_REGION_SIZE);
  const rMax = Math.floor(extent / TOWN_REGION_SIZE);
  const regions: RegionCoord[] = [];
  for (let rx = rMin; rx <= rMax; rx++) {
    for (let rz = rMin; rz <= rMax; rz++) {
      regions.push({ rx, rz });
    }
  }
  return regions;
}

/**
 * 1つの領域が持つ町候補を決定的に導出する。存在ゲート(TOWN_REGION_DENSITY)→
 * 領域内ジッター位置→適地判定(isNearTerrain)の順に評価し、どれか1つでも落ちれば
 * null(=その領域に町は無い)。
 *
 * ジッターは「領域とマップ範囲(-halfExtent..halfExtent)の交差矩形」内でサンプルする
 * (バグ修正)。旧実装は領域全体(128×128)でジッターしてからマップ範囲外を棄却して
 * いたため、マップの縁の領域(領域の大半が範囲外)ではほとんどの候補が範囲外判定で
 * 失われ、実効密度がTOWN_REGION_DENSITYよりずっと低くなっていた(91²マップは領域が
 * 4つしかなく、そのすべてが縁の領域なので影響が特に大きかった。観測: 200シード中
 * 175シードが町0個)。交差矩形内でサンプルすれば範囲外棄却は原理的に起きない。
 */
export function regionTownCandidate(
  worldSeed: number,
  rx: number,
  rz: number,
  halfExtent: number,
  field: TerrainField
): TownData | null {
  if (regionHash(worldSeed, rx, rz, 1) >= TOWN_REGION_DENSITY) return null;

  const extent = Math.max(0, halfExtent);
  const regionX0 = rx * TOWN_REGION_SIZE;
  const regionX1 = regionX0 + TOWN_REGION_SIZE - 1;
  const regionZ0 = rz * TOWN_REGION_SIZE;
  const regionZ1 = regionZ0 + TOWN_REGION_SIZE - 1;
  const x0 = Math.max(regionX0, -extent);
  const x1 = Math.min(regionX1, extent);
  const z0 = Math.max(regionZ0, -extent);
  const z1 = Math.min(regionZ1, extent);
  // regionsInRangeが返す領域は必ずマップと交差する前提だが、halfExtentが極端に
  // 小さい場合など縮退したケースの安全策として明示的にnullを返す。
  if (x0 > x1 || z0 > z1) return null;

  const jitterX = regionHash(worldSeed, rx, rz, 2);
  const jitterZ = regionHash(worldSeed, rx, rz, 3);
  const x = Math.round(x0 + jitterX * (x1 - x0));
  const z = Math.round(z0 + jitterZ * (z1 - z0));

  if (isNearTerrain(x, z, field, TOWN_TERRAIN_AVOID_RADIUS)) return null;

  const rng = regionRng(worldSeed, rx, rz);
  // 名前の一意性はここでは保証しない(巨大マップでの衝突は許容。設計判断: 領域は
  // 互いに独立でなければならず、既出名の集合という「他領域への参照」を持たせられない)。
  const name = nextTownName(rng, new Set<string>());
  const population = Math.round(
    TOWN_POPULATION_MIN + rng() * (TOWN_POPULATION_MAX - TOWN_POPULATION_MIN)
  );

  return { id: regionTownId(rx, rz), name, centre: { x, z }, population };
}

/** 新規ゲーム開始時に最低限確保する町の数。0町始まり(=乗客が誰もいない)を防ぐ。 */
export const MIN_STARTING_TOWNS = 3;
// フォールバック候補のグリッド解像度(1辺あたりの分割数)。halfExtentが大きくても
// 候補数を一定に抑える(性能はO(FALLBACK_GRID_RESOLUTION^2)で頭打ちにする)。
// 小さいマップ(既定91×91)ではほぼ全セルを候補にできるくらい細かく、16K級マップでは
// 粗いがマップ全域を一様にカバーする間隔になる。
const FALLBACK_GRID_RESOLUTION = 96;
// フォールバック町同士に要求する最低距離。通常の領域町(TOWN_MIN_DISTANCE=16)より
// 緩くしている: 山岳・水域が広いマップ(平地がマップの数%しか無いような外れ値の
// seed)では、互いに16マス離れた有効地点が3つ取れないことがある(実測: あるseedでは
// 有効地点が91×91マップの隅の小さな1ブロックにしか存在しなかった)。
// タイル占有は先勝ち(TownTileCache/buildTownIndexes)で処理されるため、多少近接
// しても致命的な破綻はない。「0町で詰む」より「多少近い町が3つ」を優先する。
const FALLBACK_TOWN_MIN_DISTANCE = 6;

// フォールバック町専用のrng(領域生成のrngとは独立したソルトで導出)。命名・人口だけに使う。
const fallbackTownRng = (worldSeed: number): (() => number) =>
  mulberry32((Math.imul(worldSeed ^ 0x2545f491, 0x27d4eb2d)) >>> 0);

/**
 * 領域生成後の町数がMIN_STARTING_TOWNSに満たない場合、決定的な格子走査で町を追加する
 * (id: town-fallback-{n})。旧実装(rejection samplingでランダムに座標を試す)は、
 * 山岳・水域が広いマップ(平地が数%しか無いような外れ値のseed)で有効な平地に
 * 全く当たらないまま試行回数を使い切ることがあった。格子走査(マップ全域を
 * FALLBACK_GRID_RESOLUTION²の候補点で一様にカバーし、決定的ハッシュ順に試す)なら、
 * 条件を満たす場所がマップ上のどこかに存在する限りほぼ確実に見つけられる。
 * 本当に候補が尽きたら(=有効な平地が無い)そこで諦める。
 */
function fillMinimumTowns(
  worldSeed: number,
  halfExtent: number,
  field: TerrainField,
  towns: TownData[]
): TownData[] {
  if (towns.length >= MIN_STARTING_TOWNS) return towns;
  const extent = Math.max(0, halfExtent);
  const result = [...towns];
  if (extent <= 0) return result;

  const step = Math.max(1, Math.ceil((2 * extent + 1) / FALLBACK_GRID_RESOLUTION));
  const candidates: { x: number; z: number; order: number }[] = [];
  for (let x = -extent; x <= extent; x += step) {
    for (let z = -extent; z <= extent; z += step) {
      candidates.push({ x, z, order: regionHash(worldSeed, x, z, 0x51a1) });
    }
  }
  candidates.sort((a, b) => a.order - b.order);

  const rng = fallbackTownRng(worldSeed);
  for (const c of candidates) {
    if (result.length >= MIN_STARTING_TOWNS) break;
    const farEnough = result.every(
      t => Math.hypot(t.centre.x - c.x, t.centre.z - c.z) >= FALLBACK_TOWN_MIN_DISTANCE
    );
    if (!farEnough) continue;
    if (isNearTerrain(c.x, c.z, field, TOWN_TERRAIN_AVOID_RADIUS)) continue;

    const usedNames = new Set(result.map(t => t.name));
    const name = nextTownName(rng, usedNames);
    const population = Math.round(
      TOWN_POPULATION_MIN + rng() * (TOWN_POPULATION_MAX - TOWN_POPULATION_MIN)
    );
    result.push({ id: `town-fallback-${result.length}`, name, centre: { x: c.x, z: c.z }, population });
  }

  return result;
}

/**
 * マップ(halfExtent)内の全領域を列挙し、町候補を持つ領域だけを実体化する。
 * O(regions)。16Kマップ(halfExtent=8192、約1.7万領域)でも数百ms未満で終わる想定
 * (性能はtowns.test.tsのガードで担保)。領域パスの結果がMIN_STARTING_TOWNSに
 * 満たない場合(小さいマップで領域数自体が少ないケース)はfillMinimumTownsで
 * 決定的に補う。16Kマップ級では領域パスだけで確実にMIN_STARTING_TOWNSを超えるため
 * no-op。
 */
export function generateRegionTowns(
  worldSeed: number,
  halfExtent: number,
  field: TerrainField
): TownData[] {
  const towns: TownData[] = [];
  for (const { rx, rz } of regionsInRange(halfExtent)) {
    const candidate = regionTownCandidate(worldSeed, rx, rz, halfExtent, field);
    if (candidate) towns.push(candidate);
  }
  return fillMinimumTowns(worldSeed, halfExtent, field, towns);
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
  field: TerrainField,
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
      if (field.terrainTypeAt(x, z) !== 'grass') continue;
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
  field: TerrainField,
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

    const spawned = spawnTownNear(info.pos, currentTowns, field, rng, railMap);
    if (!spawned) continue;
    currentTowns = [...currentTowns, spawned];
    spawnedTowns.push(spawned);
  }

  return {
    towns: spawnedTowns.length > 0 ? currentTowns : towns,
    spawnedTowns,
  };
}
