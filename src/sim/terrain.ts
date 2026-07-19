// 地形(水域・山岳)の決定的生成ロジック。純粋関数のみ。React/THREE には依存しない。
import type { TerrainType } from '../types';
import { toKey } from '../utils';

export const TERRAIN_COORD_RANGE = 45; // 生成範囲は -45..45

export const LAKE_COUNT_MIN = 3;
export const LAKE_COUNT_MAX = 5;
export const LAKE_SIZE_MIN = 20;
export const LAKE_SIZE_MAX = 60;

export const MOUNTAIN_COUNT_MIN = 2;
export const MOUNTAIN_COUNT_MAX = 3;
export const MOUNTAIN_LENGTH_MIN = 15;
export const MOUNTAIN_LENGTH_MAX = 40;
export const MOUNTAIN_WIDTH_MIN = 1;
export const MOUNTAIN_WIDTH_MAX = 2;

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
