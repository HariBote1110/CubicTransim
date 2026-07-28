// 地形(水域・山岳)の決定的生成ロジック。純粋関数のみ。React/THREE には依存しない。
import type { TerrainType } from '../types';
import { toKey, fromKey } from '../utils';

export const TERRAIN_COORD_RANGE = 45; // 生成範囲は -45..45

export const LAKE_COUNT_MIN = 3;
export const LAKE_COUNT_MAX = 5;
export const LAKE_SIZE_MIN = 20;
export const LAKE_SIZE_MAX = 60;

export const MOUNTAIN_COUNT_MIN = 2;
export const MOUNTAIN_COUNT_MAX = 3;
export const MOUNTAIN_LENGTH_MIN = 15;
export const MOUNTAIN_LENGTH_MAX = 40;
export const MOUNTAIN_WIDTH_MIN = 3;
export const MOUNTAIN_WIDTH_MAX = 6;

// mountainセルの標高はこの値でクランプする(段丘の最大段数)。
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

// 山脈: ランダムな始点から方向を揺らしつつ伸ばし、進行方向に垂直な幅を持たせてmountainにする。
const carveMountain = (terrain: Map<string, TerrainType>, rng: () => number): void => {
  const length = randInt(rng, MOUNTAIN_LENGTH_MIN, MOUNTAIN_LENGTH_MAX);
  const width = randInt(rng, MOUNTAIN_WIDTH_MIN, MOUNTAIN_WIDTH_MAX);
  let x = randInt(rng, -TERRAIN_COORD_RANGE, TERRAIN_COORD_RANGE);
  let z = randInt(rng, -TERRAIN_COORD_RANGE, TERRAIN_COORD_RANGE);
  let angle = rng() * Math.PI * 2;

  for (let i = 0; i < length; i++) {
    // 進行方向に垂直なオフセットで幅を持たせる
    const perpAngle = angle + Math.PI / 2;
    for (let w = 0; w < width; w++) {
      const offset = w - (width - 1) / 2;
      const wx = Math.round(x + Math.cos(perpAngle) * offset);
      const wz = Math.round(z + Math.sin(perpAngle) * offset);
      if (inRange(wx) && inRange(wz)) {
        terrain.set(toKey(wx, wz), 'mountain');
      }
    }
    // 方向を少し揺らしながら1歩進む
    angle += (rng() - 0.5) * 0.8;
    x += Math.cos(angle);
    z += Math.sin(angle);
  }
};

// マップ上に地形(湖・山脈)を決定的に生成する。
export function generateTerrain(rng: () => number): Map<string, TerrainType> {
  const terrain = new Map<string, TerrainType>();

  const lakeCount = randInt(rng, LAKE_COUNT_MIN, LAKE_COUNT_MAX);
  for (let i = 0; i < lakeCount; i++) {
    carveLake(terrain, rng);
  }

  // water/mountainが重なった場合は後勝ちで良いため、山脈は湖の後に処理する。
  const mountainCount = randInt(rng, MOUNTAIN_COUNT_MIN, MOUNTAIN_COUNT_MAX);
  for (let i = 0; i < mountainCount; i++) {
    carveMountain(terrain, rng);
  }

  return terrain;
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

// セル(x,z)の4面(北/東/南/西)を "x,z,dx,dz" 形式(getVectorFromDirの単位ベクトル)で表した坑口面集合。
// cliffFaces に含まれる面の2隅は、min則ではなくセル自身の標高になる(=坑口面を垂直の崖に保つ)。
const CLIFF_CORNER_MAP: Record<string, [number, number]> = {
  '0,-1': [0, 1], // 北面: 左上・右上
  '1,0': [1, 2], // 東面: 右上・右下
  '0,1': [2, 3], // 南面: 右下・左下
  '-1,0': [3, 0], // 西面: 左下・左上
};

/**
 * セル(x,z)の4隅のコーナー標高を [左上, 右上, 右下, 左下] の順で返す。
 * 左上=corner(x,z)、右上=corner(x+1,z)、右下=corner(x+1,z+1)、左下=corner(x,z+1)。
 * cliffFaces に "x,z,dx,dz" 形式でこのセルの坑口面が含まれる場合、
 * その面に接する2隅はmin則を無視してセル自身の標高にする。
 */
export function cellCornerElevations(
  elev: Map<string, number>,
  x: number,
  z: number,
  cliffFaces?: Set<string>,
): [number, number, number, number] {
  const corners: [number, number, number, number] = [
    cornerElevation(elev, x, z),
    cornerElevation(elev, x + 1, z),
    cornerElevation(elev, x + 1, z + 1),
    cornerElevation(elev, x, z + 1),
  ];

  if (cliffFaces && cliffFaces.size > 0) {
    const selfElevation = elev.get(toKey(x, z)) ?? 0;
    for (const [dirKey, [i0, i1]] of Object.entries(CLIFF_CORNER_MAP)) {
      if (cliffFaces.has(`${x},${z},${dirKey}`)) {
        corners[i0] = selfElevation;
        corners[i1] = selfElevation;
      }
    }
  }

  return corners;
}
