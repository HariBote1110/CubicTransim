// 地形(水域・山岳)の決定的生成ロジック。純粋関数のみ。React/THREE には依存しない。
//
// 標高(heights)が地形の一次データ: Map<string, number>(セルごとの整数段数、未登録=0)。
// フラクタル値ノイズで生成し、normaliseHeightsで隣接段差1以下(1-Lipschitz)を保証する。
// 地形種別はそこから導出する: 標高がMOUNTAIN_HEIGHT_THRESHOLD以上のセルがmountain、
// 湖(carveLake)のセルがwater(waterは標高0に強制する)。
import type { TerrainType } from '../types';
import { toKey, fromKey } from '../utils';

export const TERRAIN_COORD_RANGE = 45; // 生成範囲は -45..45

export const LAKE_COUNT_MIN = 3;
export const LAKE_COUNT_MAX = 5;
export const LAKE_SIZE_MIN = 20;
export const LAKE_SIZE_MAX = 60;

/** 標高の最大段数。1段の高さは描画側でOVERPASS_HEIGHTに対応する。 */
export const TERRAIN_HEIGHT_MAX = 10;

/**
 * この標高以上のセルをmountain(トンネル必須の地形)として扱う。
 *
 * 1にしているのは意図的な設計判断: 「盛り上がったセルはすべてmountain」とすることで、
 * 地上の建設(線路・駅・車庫)は従来通り標高0の平地に限られ、盛り上がった地形は
 * 従来のトンネル規則(坑口セル or 天井が覆われた内部セル)がそのまま適用される。
 * 段丘上(標高1〜4の草地)へ地上線路を敷く機能は導入しない(線路・列車の描画を
 * 段丘の高さへ持ち上げる大改修が必要になるため。progress/heights-primary-terrain.md参照)。
 */
export const MOUNTAIN_HEIGHT_THRESHOLD = 1;

// mountainセルの標高はこの値でクランプする(段丘の最大段数)。
// 旧セーブ(v13以前: heightsを持たない)の移行用computeElevation専用。
export const MOUNTAIN_ELEVATION_MAX = 3;

const randInt = (rng: () => number, min: number, max: number): number =>
  Math.floor(min + rng() * (max - min + 1));

const inRange = (v: number): boolean => v >= -TERRAIN_COORD_RANGE && v <= TERRAIN_COORD_RANGE;

// 湖: ランダムな中心からのランダムウォークでセルの塊をwaterにする。
const carveLake = (terrain: Map<string, TerrainType>, rng: () => number): void => {
  const size = randInt(rng, LAKE_SIZE_MIN, LAKE_SIZE_MAX);
  let x = randInt(rng, -TERRAIN_COORD_RANGE, TERRAIN_COORD_RANGE);
  let z = randInt(rng, -TERRAIN_COORD_RANGE, TERRAIN_COORD_RANGE);

  for (let i = 0; i < size; i++) {
    if (inRange(x) && inRange(z)) {
      terrain.set(toKey(x, z), 'water');
    }
    // 4方向へランダムに1歩進む
    const dir = Math.floor(rng() * 4);
    if (dir === 0) x += 1;
    else if (dir === 1) x -= 1;
    else if (dir === 2) z += 1;
    else z -= 1;
  }
};

// --- 標高生成(フラクタル値ノイズ) ---

// 決定的な2次元ハッシュ(mulberry32風のビット撹拌)。格子点ごとの一様乱数として使う。
const hashLattice = (seed: number, x: number, z: number): number => {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

const smoothstep01 = (t: number): number => t * t * (3 - 2 * t);

// 1オクターブぶんの値ノイズ: 波長waveの格子上の乱数をsmoothstepで双線形補間する。
const valueNoise = (seed: number, x: number, z: number, wave: number): number => {
  const gx = Math.floor(x / wave);
  const gz = Math.floor(z / wave);
  const tx = smoothstep01(x / wave - gx);
  const tz = smoothstep01(z / wave - gz);
  const v00 = hashLattice(seed, gx, gz);
  const v10 = hashLattice(seed, gx + 1, gz);
  const v01 = hashLattice(seed, gx, gz + 1);
  const v11 = hashLattice(seed, gx + 1, gz + 1);
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * tz;
};

// ノイズのオクターブ構成: [波長, 振幅]。低周波で大きな山塊・谷を、高周波で稜線の
// 細かな起伏を作る。
const NOISE_OCTAVES: ReadonlyArray<[number, number]> = [
  [22, 1],
  [11, 0.5],
  [5.5, 0.25],
];

// 平地バイアス: 合成ノイズ(0..1)がこの値以下のセルは標高0の平地になる。
// 駅・車庫・街を置ける平野を十分に残すための床(floor)。
const FLATLAND_THRESHOLD = 0.52;
// 床を超えたぶんを標高へ変換する倍率。TERRAIN_HEIGHT_MAXより大きめにして
// 山頂付近が最大段数までしっかり届くようにする(超過分はクランプ)。
const HEIGHT_GAIN = 26;

/**
 * フラクタル値ノイズによる標高マップの生成。丘・谷・尾根を持つ「がっつり高低差」の
 * 地形を作る。標高は0..TERRAIN_HEIGHT_MAXの整数で、0のセルは登録しない(未登録=0)。
 * rngから導出したシードのみに依存するため決定的。
 *
 * 注意: この段階では隣接段差1以下(1-Lipschitz)は保証されない。必ずnormaliseHeightsを
 * 通してから使うこと(generateMapはこれを行う)。
 */
export function generateHeights(
  rng: () => number,
  range: number = TERRAIN_COORD_RANGE
): Map<string, number> {
  // オクターブごとに独立したハッシュシードを決定的に引く。
  const seeds = NOISE_OCTAVES.map(() => Math.floor(rng() * 4294967296));
  const amplitudeSum = NOISE_OCTAVES.reduce((sum, [, amp]) => sum + amp, 0);

  const heights = new Map<string, number>();
  for (let x = -range; x <= range; x++) {
    for (let z = -range; z <= range; z++) {
      let noise = 0;
      for (let i = 0; i < NOISE_OCTAVES.length; i++) {
        const [wave, amp] = NOISE_OCTAVES[i];
        noise += valueNoise(seeds[i], x, z, wave) * amp;
      }
      noise /= amplitudeSum;

      const lifted = Math.max(0, noise - FLATLAND_THRESHOLD);
      const h = Math.min(TERRAIN_HEIGHT_MAX, Math.round(lifted * HEIGHT_GAIN));
      if (h > 0) heights.set(toKey(x, z), h);
    }
  }
  return heights;
}

/**
 * 標高マップを1-Lipschitz(4近傍間の段差1以下)へ正規化する。
 * result(c) = min over 全セルd (h(d) + マンハッタン距離(c,d)) を2パスの
 * チャンファー距離変換で厳密に計算する(=引き下げのみ、持ち上げはしない)。
 * 範囲外・未登録セルは標高0の固定点として扱うため、マップ端でも段差1以下になる。
 * 標高0になったセルはマップから取り除く(未登録=0の規約)。
 */
export function normaliseHeights(
  heights: Map<string, number>,
  range: number = TERRAIN_COORD_RANGE
): Map<string, number> {
  // 範囲の外側1セルぶんを標高0の固定リングとして含める。
  const lo = -range - 1;
  const hi = range + 1;
  const side = hi - lo + 1;
  const grid = new Float64Array(side * side); // 0で初期化される
  const idx = (x: number, z: number): number => (x - lo) * side + (z - lo);

  for (const [key, h] of heights) {
    const { x, z } = fromKey(key);
    // 外側リング(範囲外)は標高0の固定点なので、範囲内のセルだけ読み込む。
    if (x < -range || x > range || z < -range || z > range) continue;
    grid[idx(x, z)] = Math.max(0, Math.min(TERRAIN_HEIGHT_MAX, Math.round(h)));
  }

  // 前進パス(左・上の近傍から+1で緩和)
  for (let x = lo; x <= hi; x++) {
    for (let z = lo; z <= hi; z++) {
      let v = grid[idx(x, z)];
      if (x > lo) v = Math.min(v, grid[idx(x - 1, z)] + 1);
      if (z > lo) v = Math.min(v, grid[idx(x, z - 1)] + 1);
      grid[idx(x, z)] = v;
    }
  }
  // 後退パス(右・下の近傍から+1で緩和)
  for (let x = hi; x >= lo; x--) {
    for (let z = hi; z >= lo; z--) {
      let v = grid[idx(x, z)];
      if (x < hi) v = Math.min(v, grid[idx(x + 1, z)] + 1);
      if (z < hi) v = Math.min(v, grid[idx(x, z + 1)] + 1);
      grid[idx(x, z)] = v;
    }
  }

  const result = new Map<string, number>();
  for (let x = -range; x <= range; x++) {
    for (let z = -range; z <= range; z++) {
      const v = grid[idx(x, z)];
      if (v > 0) result.set(toKey(x, z), v);
    }
  }
  return result;
}

export interface GeneratedMap {
  terrain: Map<string, TerrainType>;
  heights: Map<string, number>;
}

/**
 * マップの地形(湖・山岳)と標高を決定的に生成する。
 *
 * 1. フラクタル値ノイズで標高を生成(generateHeights)
 * 2. 湖(carveLake)を掘り、waterセルの標高を0に強制
 * 3. normaliseHeightsで隣接段差1以下へ正規化(湖の周囲は自然な窪地になる)
 * 4. 標高がMOUNTAIN_HEIGHT_THRESHOLD以上の陸セルをmountainとする
 */
export function generateMap(rng: () => number): GeneratedMap {
  const rawHeights = generateHeights(rng);

  const terrain = new Map<string, TerrainType>();
  const lakeCount = randInt(rng, LAKE_COUNT_MIN, LAKE_COUNT_MAX);
  for (let i = 0; i < lakeCount; i++) {
    carveLake(terrain, rng);
  }
  for (const key of terrain.keys()) {
    rawHeights.delete(key); // waterは標高0
  }

  const heights = normaliseHeights(rawHeights);

  for (const [key, h] of heights) {
    if (h >= MOUNTAIN_HEIGHT_THRESHOLD && terrain.get(key) !== 'water') {
      terrain.set(key, 'mountain');
    }
  }

  return { terrain, heights };
}

// 指定座標の地形種別を返す。未登録セル(平地)は既定値'grass'。
export function terrainAt(terrain: Map<string, TerrainType>, x: number, z: number): TerrainType | 'grass' {
  return terrain.get(toKey(Math.round(x), Math.round(z))) ?? 'grass';
}

const NEIGHBOUR_OFFSETS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// mountainセルの標高を、最も近い非mountainセルまでのマンハッタン距離から決定的に導出する。
// OpenTTD風の段丘表現のため、標高はMOUNTAIN_ELEVATION_MAXでクランプする。
// 多始点BFS(全ての非mountain隣接境界を初期キューにする)でO(セル数)に計算する。
export function computeElevation(terrain: Map<string, TerrainType>): Map<string, number> {
  const elevation = new Map<string, number>();
  const visited = new Set<string>();
  let frontier: string[] = [];

  // 境界セル(mountainかつ非mountain隣接を持つ)を距離1の初期フロンティアにする。
  for (const [key, type] of terrain) {
    if (type !== 'mountain') continue;
    const { x, z } = fromKey(key);
    let isBoundary = false;
    for (const [dx, dz] of NEIGHBOUR_OFFSETS) {
      const nKey = toKey(x + dx, z + dz);
      if (terrain.get(nKey) !== 'mountain') {
        isBoundary = true;
        break;
      }
    }
    if (isBoundary) {
      elevation.set(key, 1);
      visited.add(key);
      frontier.push(key);
    }
  }

  let dist = 1;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const key of frontier) {
      const { x, z } = fromKey(key);
      for (const [dx, dz] of NEIGHBOUR_OFFSETS) {
        const nx = x + dx;
        const nz = z + dz;
        const nKey = toKey(nx, nz);
        if (visited.has(nKey)) continue;
        if (terrain.get(nKey) !== 'mountain') continue;
        visited.add(nKey);
        elevation.set(nKey, Math.min(dist + 1, MOUNTAIN_ELEVATION_MAX));
        next.push(nKey);
      }
    }
    frontier = next;
    dist += 1;
  }

  return elevation;
}

// 指定座標の標高を返す。未登録セル(平地・水域含む)は既定値0。
export function elevationAt(elevation: Map<string, number>, x: number, z: number): number {
  return elevation.get(toKey(Math.round(x), Math.round(z))) ?? 0;
}

/**
 * コーナー標高。コーナー(cx,cz)は世界座標(cx-0.5, cz-0.5)の点で、
 * セル(cx-1,cz-1)/(cx,cz-1)/(cx-1,cz)/(cx,cz) の4セルが囲む頂点にあたる。
 * これら4セルの標高(未登録は0)の最小値を返す。min則により、
 * 隣接セル間の標高差は常に1以下(=距離関数が1-Lipschitzであるため)なので、
 * 生成される面は必ず連続した斜面になる。
 */
export function cornerElevation(elev: Map<string, number>, cx: number, cz: number): number {
  const cells: Array<[number, number]> = [
    [cx - 1, cz - 1],
    [cx, cz - 1],
    [cx - 1, cz],
    [cx, cz],
  ];
  let min = Infinity;
  for (const [x, z] of cells) {
    const e = elev.get(toKey(x, z)) ?? 0;
    if (e < min) min = e;
  }
  return min;
}

// コーナーのインデックス[左上,右上,右下,左下]それぞれに対応する、セル(x,z)から見た
// コーナー座標へのオフセット。cornerElevationの引数(cx,cz)はこれをx,zへ足した値。
const CORNER_COORD_DELTAS: ReadonlyArray<[number, number]> = [
  [0, 0], // 左上 = corner(x,z)
  [1, 0], // 右上 = corner(x+1,z)
  [1, 1], // 右下 = corner(x+1,z+1)
  [0, 1], // 左下 = corner(x,z+1)
];

const cornerKeyOfCell = (x: number, z: number, cornerIndex: number): string => {
  const [dx, dz] = CORNER_COORD_DELTAS[cornerIndex];
  return toKey(x + dx, z + dz);
};

/**
 * mountainの全セルについて、4隅のコーナー標高を「コーナー座標→標高」の共有マップとして
 * 一括構築する。同じコーナーを共有する隣接セルは常に同じ値を参照するため、
 * どのセルからこのマップを参照しても上面メッシュに裂け目ができない。
 */
export function buildCornerElevationMap(elev: Map<string, number>): Map<string, number> {
  const corners = new Map<string, number>();

  for (const key of elev.keys()) {
    const { x, z } = fromKey(key);
    for (let i = 0; i < 4; i++) {
      const ck = cornerKeyOfCell(x, z, i);
      if (corners.has(ck)) continue;
      const [dx, dz] = CORNER_COORD_DELTAS[i];
      corners.set(ck, cornerElevation(elev, x + dx, z + dz));
    }
  }

  return corners;
}

/**
 * buildCornerElevationMapが返す共有マップから、セル(x,z)の4隅を
 * [左上, 右上, 右下, 左下] の順で読み出す。マップに無いコーナー(=mountainが
 * どこにも無い座標)は標高0として扱う。
 */
export function cellCornersFromMap(
  corners: Map<string, number>,
  x: number,
  z: number,
): [number, number, number, number] {
  return [
    corners.get(cornerKeyOfCell(x, z, 0)) ?? 0,
    corners.get(cornerKeyOfCell(x, z, 1)) ?? 0,
    corners.get(cornerKeyOfCell(x, z, 2)) ?? 0,
    corners.get(cornerKeyOfCell(x, z, 3)) ?? 0,
  ];
}

/**
 * セル(x,z)の4隅のコーナー標高を [左上, 右上, 右下, 左下] の順で返す。
 * 左上=corner(x,z)、右上=corner(x+1,z)、右下=corner(x+1,z+1)、左下=corner(x,z+1)。
 *
 * 内部的にはbuildCornerElevationMapを経由する。多数のセルをまとめて描画する場合は
 * buildCornerElevationMapを1度だけ呼び、cellCornersFromMapで個別に読み出すほうが
 * 効率的(この関数は単発利用向け)。
 */
export function cellCornerElevations(
  elev: Map<string, number>,
  x: number,
  z: number,
): [number, number, number, number] {
  const corners = buildCornerElevationMap(elev);
  return cellCornersFromMap(corners, x, z);
}
