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
}

// --- 決定的ハッシュ(格子点ごとの一様乱数) ---

// mulberry32風のビット撹拌。terrain.tsのhashLatticeと同じ考え方だが、
// オクターブごとのseedはrng(状態を持つ乱数生成器)からではなく、
// (フィールドseed, オクターブ番号)から純粋に導出する(下のderiveOctaveSeed)。
const hashLattice = (seed: number, x: number, z: number): number => {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

// murmur3風のfinalizerで(フィールドseed, オクターブ番号)から32bit整数シードを導出する。
// rngの逐次状態を使わないため、任意のオクターブのシードを他のオクターブと無関係にO(1)で得られる
// (チャンク非依存性の要件: heightAtがどのセルからでも同じ結果を出す必要がある)。
const deriveOctaveSeed = (seed: number, index: number): number => {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b9)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};

const smoothstep01 = (t: number): number => t * t * (3 - 2 * t);

// 1オクターブぶんの値ノイズ: 波長waveの格子上の乱数[0,1]をsmoothstepで双線形補間する。
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

// --- ノイズのオクターブ構成と1-Lipschitzの構成的な導出 ---
//
// [波長, 振幅] の組。terrain.tsと同様、低周波の大きな地形に高周波の細部を重ねる。
// wave はすべて 5 以上(波長がセル1個分に対して十分大きい)にしてある。
const NOISE_OCTAVES: ReadonlyArray<[number, number]> = [
  [40, 1],
  [20, 0.5],
  [10, 0.25],
  [5, 0.125],
];
const AMPLITUDE_SUM = NOISE_OCTAVES.reduce((sum, [, amp]) => sum + amp, 0); // 1.875

// 合成ノイズ(0..1)がこの値以下のセルは標高0(平地)になる。terrain.tsのFLATLAND_THRESHOLDと
// 同じ役割。平地率を過半にするため0.5よりやや高めに設定。
const FLATLAND_THRESHOLD = 0.55;

// 同じ合成ノイズ値がこの値未満のセルはwater(標高は自動的に0になる。下記コメント参照)。
// FLATLAND_THRESHOLD より十分低いことが前提(水域は必ず「平地化フロア」の内側にあるため、
// 湖の縁は必然的に標高0の平地と滑らかに接続する)。
const WATER_THRESHOLD = 0.15;

// 平地フロアを超えたぶんを標高へ変換する倍率。
//
// 1-Lipschitzの導出:
//   smoothstepの導関数 S'(t) = 6t(1-t) の最大値は t=0.5 で 1.5。
//   1オクターブの値ノイズは、格子点の値(すべて[0,1])の凸結合をsmoothstepで補間したものなので、
//   x方向(zを固定)の傾き |d(valueNoise)/dx| は、格子点差の絶対値(最大1)× S'(tx)の最大値(1.5)
//   ÷ 波長wave で抑えられる: |d(valueNoise_i)/dx| <= 1.5 / wave_i。z方向も同様(双線形補間の
//   対称性による)。
//
//   合成ノイズ noise = Σ amp_i * valueNoise_i / AMPLITUDE_SUM なので、
//   |d(noise)/dx| <= Σ (amp_i / AMPLITUDE_SUM) * (1.5 / wave_i)
//                  = 1.5/AMPLITUDE_SUM * Σ (amp_i / wave_i)
//   NOISE_OCTAVESでは Σ(amp_i/wave_i) = 1/40 + 0.5/20 + 0.25/10 + 0.125/5 = 0.1 なので、
//   |d(noise)/dx| <= 1.5 * 0.1 / 1.875 = 0.08。
//
//   標高(rounding前)は HEIGHT_GAIN * max(0, noise - FLATLAND_THRESHOLD)。max(0, ·) は
//   1-Lipschitzを広げない(傾きを弱めるか0にするだけ)ので、
//   |Δheight_raw| <= HEIGHT_GAIN * |Δnoise| <= HEIGHT_GAIN * 0.08 (連続近似での上界)。
//
//   これが 1 以下であれば、「1-Lipschitzな連続関数を最近接整数に丸めると、隣接する
//   整数値の差はやはり1以下になる」という事実(丸めのズレは片側最大0.5、往復しても
//   連続差+1を超えない)より、量子化後も隣接差1以下が保証される。
//   HEIGHT_GAIN=11 なら 11*0.08=0.88 < 1 となり、正規化パスなしで安全マージンを確保できる。
const HEIGHT_GAIN = 11;

// 指定された頂点座標(x,z)の合成ノイズ値(0..1相当。理論上はこの範囲に収まる)を返す。
// cornerHeightAt/terrainTypeAt の両方がこの同一の連続場を参照することで、水域(低い側の閾値)と
// 陸地の標高(高い側の閾値からの持ち上げ)が同じ場に基づく一貫した挙動になる。
const compositeNoise = (seed: number, x: number, z: number): number => {
  let noise = 0;
  for (let i = 0; i < NOISE_OCTAVES.length; i++) {
    const [wave, amp] = NOISE_OCTAVES[i];
    const octaveSeed = deriveOctaveSeed(seed, i);
    noise += valueNoise(octaveSeed, x, z, wave) * amp;
  }
  return noise / AMPLITUDE_SUM;
};

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
 */
export function createTerrainField(seed: number, halfExtent: number): TerrainField {
  const inRange = (v: number): boolean => v >= -halfExtent && v <= halfExtent;

  const cornerHeightAt = (x: number, z: number): number => {
    const ix = Math.round(x);
    const iz = Math.round(z);
    if (!inRange(ix) || !inRange(iz)) return 0;
    const noise = compositeNoise(seed, ix, iz);
    if (noise < WATER_THRESHOLD) return 0;
    const lifted = Math.max(0, noise - FLATLAND_THRESHOLD);
    return Math.min(TERRAIN_HEIGHT_MAX, Math.round(lifted * HEIGHT_GAIN));
  };

  // 頂点(x,z)がwater側の閾値未満か(=標高0が「地形として低い」ためではなく、湖の水面だから)。
  // cornerHeightAtの値だけでは平地(高さ0)と水面(高さ0)を区別できないため、セルのwater判定に使う。
  const isWaterVertex = (x: number, z: number): boolean => {
    const ix = Math.round(x);
    const iz = Math.round(z);
    if (!inRange(ix) || !inRange(iz)) return false;
    return compositeNoise(seed, ix, iz) < WATER_THRESHOLD;
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
    // water: セルの4隅すべてがwater側の頂点(=完全に平坦な標高0の水面)であること。
    if (isWaterVertex(x, z) && isWaterVertex(x + 1, z) && isWaterVertex(x, z + 1) && isWaterVertex(x + 1, z + 1)) {
      return 'water';
    }
    return cellHeightAt(x, z) >= MOUNTAIN_HEIGHT_THRESHOLD ? 'mountain' : 'grass';
  };

  return { cornerHeightAt, cellCornerHeights, cellHeightAt, terrainTypeAt };
}
