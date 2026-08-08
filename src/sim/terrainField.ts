// チャンク非依存(=どのセルもO(1)で単独計算できる)な純関数の地形field。
// React/THREE には依存しない。16384四方までの大マップで全セル実体化(terrain.tsのMap方式)
// を避けるため、heightAt(x,z)/terrainTypeAt(x,z) をseedのみから決定的に導出する。
// 詳細な設計判断は progress/16k-map-architecture.md 参照。
//
// terrain.ts との違い: terrain.ts は生成後にnormaliseHeights(全域2パスの距離変換)で
// 1-Lipschitz(4近傍の標高差1以下)を「後付けで」保証しているが、これはチャンク独立生成と
// 両立しない(境界の正規化に全域参照が要る)。terrainField.ts はノイズの各オクターブの
// 振幅/波長そのものを縛ることで、正規化パスなしに「構成で」1-Lipschitzを保証する
// (詳細は下記コメント参照)。

import type { TerrainType } from '../types';
import { toKey } from '../utils';
import {
  NOISE_WAVE_WEIGHTS,
  compositeNoiseNumerator,
  deriveSeedU32,
  hashU32,
  heightFromNumeratorWith,
  heightThresholdsFor,
  isWaterNumerator,
  lerpQ,
  smoothQ,
} from './canonicalNoise';
import type { TerrainProfile } from './canonicalNoise';

export type { TerrainProfile } from './canonicalNoise';
export { TERRAIN_PROFILES } from './canonicalNoise';

/** 地形プロファイルの既定値。省略時は歴史的な標準(normal)。 */
export const DEFAULT_TERRAIN_PROFILE: TerrainProfile = 'normal';

/** 既定マップの生成半径(-45..45)。旧terrain.tsのTERRAIN_COORD_RANGEを引き継ぐ。 */
export const DEFAULT_HALF_EXTENT = 45;

export const TERRAIN_HEIGHT_MAX = 10;

// この標高以上のセルをmountainとして扱う。terrain.tsのMOUNTAIN_HEIGHT_THRESHOLDと同じ規約
// (「盛り上がったセルはすべてmountain」)。
export const MOUNTAIN_HEIGHT_THRESHOLD = 1;

export type TerrainKind = 'grass' | 'mountain' | 'water';

// セル(x,z)の4隅コーナーの並び順。x増加=東、z増加=南とする(terrain.tsのworld座標と同じ向き)。
// nw=(x,z), ne=(x+1,z), sw=(x,z+1), se=(x+1,z+1)。
export type CellCorners = [nw: number, ne: number, sw: number, se: number];

export interface TerrainField {
  /**
   * 頂点格子(コーナー)の標高。これが一次データ: OpenTTD同様、セルの形状は
   * 4隅のコーナー標高から導出する(将来の勾配建設の前提)。1-Lipschitz(隣接コーナー
   * 標高差1以下)はこの格子に対して構成保証される。
   */
  cornerHeightAt(x: number, z: number): number;
  /** セル(x,z)の4隅コーナー標高を [nw, ne, sw, se] で返す。 */
  cellCornerHeights(x: number, z: number): CellCorners;
  /**
   * セル(x,z)の代表標高(4隅のmin)。現行ゲーム(terrain.tsのmin則コーナー導出)との
   * 互換ヘルパ。段丘上の建設に対応するまでの移行期の消費側向け。
   */
  cellHeightAt(x: number, z: number): number;
  /** セル(x,z)の地形種別。water/mountain/grassの判定はcellCornerHeightsから導出する。 */
  terrainTypeAt(x: number, z: number): TerrainKind;
  /**
   * P9a: (w+1)×(h+1) のコーナー格子([x0..x0+w]×[z0..z0+h])を1回でまとめて評価する
   * バッチAPI(任意実装)。戻り値の添字は `lx*(h+1)+lz`(lx=x-x0, lz=z-z0)。
   * 各要素は同じ座標に対する `cornerHeightAt(x0+lx, z0+lz)` と厳密に一致すること
   * (プロパティテストで保証)。未実装の場合は呼び出し側が `cornerGridFor` ヘルパー
   * (下記のモジュール関数)経由でcornerHeightAtへフォールバックする。
   */
  cornerGridFor?(x0: number, z0: number, w: number, h: number): Uint8Array;
  /**
   * P9a: cornerGridForと同じ格子・添字規約で、コーナーがwater側の頂点かどうかを
   * 1/0で返すバッチAPI(任意実装)。terrainTypeAtのwater判定(isWaterVertex)を
   * セルごとに4回再計算させないためのもの。
   */
  waterCornerGridFor?(x0: number, z0: number, w: number, h: number): Uint8Array;
}

// --- 決定的ハッシュ・ノイズ ---
//
// progress/canonical-terrain-noise-integer.md の正準整数固定小数点定義(u32/64bit整数演算のみ、
// 浮動小数点は一切介在しない)を ./canonicalNoise.ts が実装している。ここでは合成ノイズ分子N
// (=8*q0+4*q1+2*q2+q3)から標高・water判定を導出するだけの薄いラッパーにする。
//
// 旧実装(f64のsmoothstep + FLATLAND_THRESHOLD/HEIGHT_GAINによる後付けスケーリング)は
// WASMレンダラーとのノイズ不一致を解消するため、この正準整数定義に一本化された
// (既存seedの地形形状が変わることは移行時に許容: progress/16k-map-architecture.md参照)。
//
// 1-Lipschitzは正準定義でも同じオクターブ構造(波長40/20/10/5、smoothstep補間)を保つため
// 構成的に成立する(既存のプロパティテストで担保)。

/**
 * seedとhalfExtentから、チャンク非依存(O(1)/頂点)の地形fieldを作る。
 *
 * 一次データはコーナー(頂点)格子: `cornerHeightAt` が1-Lipschitzを構成保証する対象。
 * セル単位の値(`cellCornerHeights`/`cellHeightAt`/`terrainTypeAt`)はすべてこの頂点格子
 * から導出する薄いヘルパ。
 *
 * 範囲外(|x|または|z| > halfExtent)は頂点標高0(=グリッド越しには 'grass'/標高0)を
 * 返す設計判断: 16Kマップでも建設可能領域はhalfExtent内に限られるため、境界の外側は
 * 「常に安全な平地」として扱えば十分であり、範囲外との連続性(1-Lipschitz)を
 * 保証するための追加コストを払う必要がない。
 *
 * `profile`(平坦/標準/山がち)は「Nを標高へ落とすしきい値テーブル」だけを差し替える。
 * ハッシュ・オクターブ・合成ノイズ分子Nの計算は共通なので、正準定義のバイト一致検証
 * (TS/Rust/WGSL)はプロファイルを跨いでそのまま成立する。省略時はnormal(歴史的既定)。
 */
export function createTerrainField(
  seed: number,
  halfExtent: number,
  profile: TerrainProfile = DEFAULT_TERRAIN_PROFILE
): TerrainField {
  const inRange = (v: number): boolean => v >= -halfExtent && v <= halfExtent;
  // しきい値テーブルはfield生成時に1度だけ解決する(頂点ごとのRecord引きを避ける)。
  const thresholds = heightThresholdsFor(profile);
  const heightFromNumerator = (n: number): number => heightFromNumeratorWith(n, thresholds);

  // --- P9a: バッチ用の合成ノイズ分子(N)格子計算 ---
  //
  // オクターブ格子の構造を利用する: valueNoiseQ(wave)が実際に参照する格子点(gx,gz)は
  // window(w+1)×(h+1)個の頂点に対して floor(window/wave)+2 個程度しかない
  // (waveが5以上・windowがチャンク=32程度なら1オクターブあたり高々十数個)。
  // 頂点ごとにhashU32を呼ぶ(旧cornerHeightAtの経路)代わりに、この少数の格子点のu32
  // ハッシュ値を先に計算しておき、各頂点はその配列引きとlerpQ(64bit積)だけで済ませる。
  // canonicalNoise.tsのcompositeNoiseNumerator(単一頂点版)と完全に同じ値になることを
  // プロパティテストで保証する。
  const noiseNumeratorGridFor = (x0: number, z0: number, w: number, h: number): Float64Array => {
    const gw = w + 1;
    const gh = h + 1;
    const noise = new Float64Array(gw * gh);
    for (let oi = 0; oi < NOISE_WAVE_WEIGHTS.length; oi++) {
      const [wave, weight] = NOISE_WAVE_WEIGHTS[oi];
      const octaveSeed = deriveSeedU32(seed, oi);

      const gx0 = Math.floor(x0 / wave);
      const gx1 = Math.floor((x0 + w) / wave) + 1;
      const gz0 = Math.floor(z0 / wave);
      const gz1 = Math.floor((z0 + h) / wave) + 1;
      const lgw = gx1 - gx0 + 1;
      const lgh = gz1 - gz0 + 1;
      const latticeHash = new Float64Array(lgw * lgh);
      for (let lgx = 0; lgx < lgw; lgx++) {
        for (let lgz = 0; lgz < lgh; lgz++) {
          latticeHash[lgx * lgh + lgz] = hashU32(octaveSeed, gx0 + lgx, gz0 + lgz);
        }
      }

      for (let lx = 0; lx < gw; lx++) {
        const x = x0 + lx;
        const { grid: gxAbs, t: tx } = smoothQ(x, wave);
        const gx = gxAbs - gx0;
        for (let lz = 0; lz < gh; lz++) {
          const z = z0 + lz;
          const { grid: gzAbs, t: tz } = smoothQ(z, wave);
          const gz = gzAbs - gz0;
          const v00 = latticeHash[gx * lgh + gz];
          const v10 = latticeHash[(gx + 1) * lgh + gz];
          const v01 = latticeHash[gx * lgh + (gz + 1)];
          const v11 = latticeHash[(gx + 1) * lgh + (gz + 1)];
          const top = lerpQ(v00, v10, tx);
          const bottom = lerpQ(v01, v11, tx);
          const value = lerpQ(top, bottom, tz);
          noise[lx * gh + lz] += value * weight;
        }
      }
    }
    return noise;
  };

  const cornerGridForImpl = (x0: number, z0: number, w: number, h: number): Uint8Array => {
    const gw = w + 1;
    const gh = h + 1;
    const noise = noiseNumeratorGridFor(x0, z0, w, h);
    const grid = new Uint8Array(gw * gh);
    for (let lx = 0; lx < gw; lx++) {
      const x = x0 + lx;
      for (let lz = 0; lz < gh; lz++) {
        const z = z0 + lz;
        const idx = lx * gh + lz;
        if (!inRange(x) || !inRange(z)) {
          grid[idx] = 0;
          continue;
        }
        grid[idx] = Math.min(TERRAIN_HEIGHT_MAX, heightFromNumerator(noise[idx]));
      }
    }
    return grid;
  };

  const waterCornerGridForImpl = (x0: number, z0: number, w: number, h: number): Uint8Array => {
    const gw = w + 1;
    const gh = h + 1;
    const noise = noiseNumeratorGridFor(x0, z0, w, h);
    const grid = new Uint8Array(gw * gh);
    for (let lx = 0; lx < gw; lx++) {
      const x = x0 + lx;
      for (let lz = 0; lz < gh; lz++) {
        const z = z0 + lz;
        const idx = lx * gh + lz;
        if (!inRange(x) || !inRange(z)) {
          grid[idx] = 0;
          continue;
        }
        grid[idx] = isWaterNumerator(noise[idx]) ? 1 : 0;
      }
    }
    return grid;
  };

  const cornerHeightAt = (x: number, z: number): number => {
    const ix = Math.round(x);
    const iz = Math.round(z);
    if (!inRange(ix) || !inRange(iz)) return 0;
    const n = compositeNoiseNumerator(seed, ix, iz);
    return Math.min(TERRAIN_HEIGHT_MAX, heightFromNumerator(n));
  };

  const cellCornerHeights = (x: number, z: number): CellCorners => [
    cornerHeightAt(x, z),
    cornerHeightAt(x + 1, z),
    cornerHeightAt(x, z + 1),
    cornerHeightAt(x + 1, z + 1),
  ];

  const cellHeightAt = (x: number, z: number): number => {
    const [nw, ne, sw, se] = cellCornerHeights(x, z);
    return Math.min(nw, ne, sw, se);
  };

  // (nw,ne,sw,se)の4隅。terrainTypeAtは「water判定」と「標高」の両方を必要とするが、
  // どちらも同じcompositeNoiseNumerator(N)から導出できるため、頂点ごとに1回だけ評価して
  // height/waterの両方をそこから読み出す(旧: isWaterVertex×4 + cellHeightAt(cornerHeightAt×4)の
  // 8回評価を4回へ半減)。
  const CELL_CORNER_OFFSETS: ReadonlyArray<[number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1]];

  const terrainTypeAt = (x: number, z: number): TerrainKind => {
    let allWater = true;
    let minHeight = TERRAIN_HEIGHT_MAX;
    for (const [dx, dz] of CELL_CORNER_OFFSETS) {
      const ix = Math.round(x + dx);
      const iz = Math.round(z + dz);
      if (!inRange(ix) || !inRange(iz)) {
        allWater = false;
        minHeight = 0;
        continue;
      }
      const n = compositeNoiseNumerator(seed, ix, iz);
      if (!isWaterNumerator(n)) allWater = false;
      const h = Math.min(TERRAIN_HEIGHT_MAX, heightFromNumerator(n));
      if (h < minHeight) minHeight = h;
    }
    if (allWater) return 'water';
    return minHeight >= MOUNTAIN_HEIGHT_THRESHOLD ? 'mountain' : 'grass';
  };

  return {
    cornerHeightAt, cellCornerHeights, cellHeightAt, terrainTypeAt,
    cornerGridFor: cornerGridForImpl,
    waterCornerGridFor: waterCornerGridForImpl,
  };
}

/**
 * 手組みの(セル単位)heights/terrain Mapを TerrainField としてラップする橋渡しヘルパー。
 * デバッグシナリオ(debugScenarios.ts)や、Mapを直接組み立てるテストのフィクスチャを
 * field APIへ移行するために使う。コーナー標高の導出規約はterrain.tsの
 * cellCornerElevations(min則: コーナー(cx,cz)を囲む4セル(cx-1,cz-1)/(cx,cz-1)/(cx-1,cz)/(cx,cz)
 * のうち最小の標高)と完全に同じにしてある。
 *
 * terrainTypeAtはheightsからの導出ではなく、terrain Mapの明示的な値(あれば)を優先する。
 * water判定は標高からは導出できない(標高0=平地と標高0=水面を区別できない)ため、
 * 呼び出し側が組み立てたterrain Mapのwaterマーカーをそのまま信頼する。
 */
export function fieldFromMaps(
  heights: Map<string, number>,
  terrain: Map<string, TerrainType>,
  halfExtent: number
): TerrainField {
  const inRange = (v: number): boolean => v >= -halfExtent && v <= halfExtent;
  const cellHeight = (x: number, z: number): number => {
    if (!inRange(x) || !inRange(z)) return 0;
    return heights.get(toKey(x, z)) ?? 0;
  };

  const cornerHeightAt = (x: number, z: number): number => {
    const ix = Math.round(x);
    const iz = Math.round(z);
    const cells: ReadonlyArray<[number, number]> = [
      [ix - 1, iz - 1],
      [ix, iz - 1],
      [ix - 1, iz],
      [ix, iz],
    ];
    let min = Infinity;
    for (const [cx, cz] of cells) {
      const h = cellHeight(cx, cz);
      if (h < min) min = h;
    }
    return min === Infinity ? 0 : min;
  };

  const cellCornerHeights = (x: number, z: number): CellCorners => [
    cornerHeightAt(x, z),
    cornerHeightAt(x + 1, z),
    cornerHeightAt(x, z + 1),
    cornerHeightAt(x + 1, z + 1),
  ];

  const cellHeightAt = (x: number, z: number): number => {
    const [nw, ne, sw, se] = cellCornerHeights(x, z);
    return Math.min(nw, ne, sw, se);
  };

  const terrainTypeAt = (x: number, z: number): TerrainKind => {
    const ix = Math.round(x);
    const iz = Math.round(z);
    const t = terrain.get(toKey(ix, iz));
    if (t === 'water') return 'water';
    if (t === 'mountain') return 'mountain';
    return cellHeightAt(ix, iz) >= MOUNTAIN_HEIGHT_THRESHOLD ? 'mountain' : 'grass';
  };

  return { cornerHeightAt, cellCornerHeights, cellHeightAt, terrainTypeAt };
}

// --- P9a: バッチAPIの呼び出しヘルパー ---
//
// TerrainField.cornerGridFor/waterCornerGridForは任意実装(実装を持たないfieldや
// テストのリテラルフィクスチャもあるため)。呼び出し側(render層)は必ずこの
// モジュール関数を経由することで、未実装のfieldに対しても
// cornerHeightAt/isWaterVertex相当への逐次フォールバックで動作を保証する。

/**
 * (w+1)×(h+1)のコーナー格子を返す。fieldがcornerGridForを実装していればそれを使い、
 * 無ければcornerHeightAtへの逐次呼び出しにフォールバックする。戻り値の添字規約は
 * TerrainField.cornerGridForと同じ(`lx*(h+1)+lz`, lx=x-x0, lz=z-z0)。
 */
export function cornerGridFor(field: TerrainField, x0: number, z0: number, w: number, h: number): Uint8Array {
  if (field.cornerGridFor) return field.cornerGridFor(x0, z0, w, h);
  const gh = h + 1;
  const grid = new Uint8Array((w + 1) * gh);
  for (let lx = 0; lx <= w; lx++) {
    for (let lz = 0; lz <= h; lz++) {
      grid[lx * gh + lz] = field.cornerHeightAt(x0 + lx, z0 + lz);
    }
  }
  return grid;
}

/**
 * cornerGridForと同じ格子・添字規約で、コーナーがwater側の頂点かどうかを1/0で返す。
 * fieldがwaterCornerGridForを実装していなければ、terrainTypeAtで包囲4セルを調べて
 * 「4隅すべてwater」の頂点だけを1にする(cornerGridForの旧isWaterVertex相当のフォールバック)。
 * 高頻度パスでは使われない想定(フォールバック経路はfieldFromMaps/デバッグシナリオ用)。
 */
export function waterCornerGridFor(field: TerrainField, x0: number, z0: number, w: number, h: number): Uint8Array {
  if (field.waterCornerGridFor) return field.waterCornerGridFor(x0, z0, w, h);
  const gh = h + 1;
  const grid = new Uint8Array((w + 1) * gh);
  for (let lx = 0; lx <= w; lx++) {
    for (let lz = 0; lz <= h; lz++) {
      const x = x0 + lx;
      const z = z0 + lz;
      // 頂点(x,z)を共有する4セルすべてがwaterなら、その頂点はwater側とみなす。
      const cells: ReadonlyArray<[number, number]> = [[x - 1, z - 1], [x, z - 1], [x - 1, z], [x, z]];
      grid[lx * gh + lz] = cells.every(([cx, cz]) => field.terrainTypeAt(cx, cz) === 'water') ? 1 : 0;
    }
  }
  return grid;
}

/**
 * cornerGridFor/waterCornerGridForの格子から、ローカルセル座標(lx,lz)(cell
 * (x0+lx, z0+lz)に対応、lxは[0,w-1]、lzは[0,h-1])の4隅コーナー標高を
 * [nw,ne,sw,se]で取り出す。gh=h+1(格子の1列あたりの高さ)。
 */
export function cellCornersFromGrid(grid: Uint8Array, gh: number, lx: number, lz: number): CellCorners {
  return [
    grid[lx * gh + lz],
    grid[(lx + 1) * gh + lz],
    grid[lx * gh + (lz + 1)],
    grid[(lx + 1) * gh + (lz + 1)],
  ];
}
