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

// mountainセルを4近傍(上下左右)へ1セルぶん膨張(dilation)させる。
//
// 山脈生成のランダムウォークは幅1セルの尾根区間を作りうる。cellCornerElevations
// のmin則では「幅1セルの尾根」は4隅すべてが標高0になり(=境界セルなのに内部セルが
// 存在しないため)、地形が完全に平地化して描画されてしまう。膨張により元のセルが
// 必ず内部セル(4方向にmountainの隣接を持つセル)を得られるようにし、稜線の標高が
// 1以上になるようにする。
//
// 生成範囲(TERRAIN_COORD_RANGE)外へは膨張しない(クランプ)。water/mountainが重なる
// 場合はmountainを優先する(generateTerrainの「後勝ち」方針と異なり、ここでは膨張元の
// mountainが主役のため上書きしてよい)。
export function dilateMountains(terrain: Map<string, TerrainType>): Map<string, TerrainType> {
  const dilated = new Map(terrain);

  for (const [key, type] of terrain) {
    if (type !== 'mountain') continue;
    const { x, z } = fromKey(key);
    for (const [dx, dz] of NEIGHBOUR_OFFSETS) {
      const nx = x + dx;
      const nz = z + dz;
      if (!inRange(nx) || !inRange(nz)) continue;
      dilated.set(toKey(nx, nz), 'mountain');
    }
  }

  return dilated;
}

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

  // 幅1セルの尾根が完全に平地化して見えないよう、mountainを1セル膨張させる。
  return dilateMountains(terrain);
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
// render層(TerrainBlocks)でも坑口の垂直壁クアッドの対象コーナーを特定するために使うため公開する。
export const CLIFF_CORNER_MAP: Record<string, [number, number]> = {
  '0,-1': [0, 1], // 北面: 左上・右上
  '1,0': [1, 2], // 東面: 右上・右下
  '0,1': [2, 3], // 南面: 右下・左下
  '-1,0': [3, 0], // 西面: 左下・左上
};

// 坑口面の垂直壁として持ち上げる段数の上限。セル標高が高くても崖は1段ぶんだけに
// 抑え、地表から巨大な壁が突き出さないようにする(トンネル内のレールは常に地表と
// 同じ高さを走るため、坑口も1段の崖で十分)。
const CLIFF_LIFT_MAX = 1;

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
 * 一括構築する。cellCornerElevationsのようにセル単位で個別に計算すると、cliffFacesを
 * 宣言したセルの視点でしか持ち上げが反映されず、同じコーナーを共有する隣接セル(cliffFaces
 * 非宣言側)は元のmin則の値のままになって上面メッシュに裂け目ができてしまう。
 * この関数はcliffFacesによる持ち上げを「コーナー単位」で一度だけ適用するため、
 * どのセルからこのマップを参照しても同じコーナーは必ず同じ値になり、裂け目が原理的に
 * 起こらない。
 */
export function buildCornerElevationMap(
  elev: Map<string, number>,
  cliffFaces?: Set<string>,
): Map<string, number> {
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

  if (cliffFaces && cliffFaces.size > 0) {
    for (const key of elev.keys()) {
      const { x, z } = fromKey(key);
      const selfElevation = elev.get(key) ?? 0;
      const lift = Math.min(selfElevation, CLIFF_LIFT_MAX);
      for (const [dirKey, [i0, i1]] of Object.entries(CLIFF_CORNER_MAP)) {
        if (!cliffFaces.has(`${x},${z},${dirKey}`)) continue;
        for (const i of [i0, i1]) {
          const ck = cornerKeyOfCell(x, z, i);
          corners.set(ck, Math.max(corners.get(ck) ?? 0, lift));
        }
      }
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
 * cliffFaces に "x,z,dx,dz" 形式でこのセルの坑口面が含まれる場合、その面に接する
 * 2隅はmin則の値と「セル標高をCLIFF_LIFT_MAXまでに制限した値」の大きい方にする
 * (自然な標高のほうが高い場合はmin則の連続性を優先し、そちらを採る)。
 *
 * 内部的にはbuildCornerElevationMap(コーナー単位で持ち上げを適用する共有マップ)を
 * 経由する。多数のセルをまとめて描画する場合はbuildCornerElevationMapを1度だけ呼び、
 * cellCornersFromMapで個別に読み出すほうが効率的(この関数は単発利用向け)。
 */
export function cellCornerElevations(
  elev: Map<string, number>,
  x: number,
  z: number,
  cliffFaces?: Set<string>,
): [number, number, number, number] {
  const corners = buildCornerElevationMap(elev, cliffFaces);
  return cellCornersFromMap(corners, x, z);
}
