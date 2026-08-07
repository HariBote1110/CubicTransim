// 正準整数ノイズ(progress/canonical-terrain-noise-integer.md)のTS実装。
// BigIntは使わず、u32のペアで64bit演算する。ホットパス(hashU32/lerpQ等)はすべて
// 素のnumber演算(Math.imul + >>>0、または倍精度で厳密に収まる整数演算)のみで構成する。
//
// 合成ノイズ分子 N = 8*q0+4*q1+2*q2+q3 は最大 15*(2^32-1) ≈ 6.44e10 で、
// Number.isSafeIntegerの上限(2^53≈9.0e15)に十分収まるため、64bit分割なしの
// プレーンなnumber演算で厳密に計算できる。64bit分割が本当に必要なのは
// lerpQ内部の (2^32未満の値)×(2^32未満の値) の積(最大約1.8e19)だけ。

/**
 * u32×u32の厳密な64bit積の上位32bit floor(a*b/2^32) だけを返す(オブジェクト非生成)。
 * lerpQのホットパス専用: lerpQが必要とするのは積の上位ワードのみなので、下位32bitは計算しない。
 */
function mulHi32(a: number, b: number): number {
  const aLo = a & 0xffff;
  const aHi = a >>> 16;
  const bLo = b & 0xffff;
  const bHi = b >>> 16;
  const p0 = aLo * bLo;
  const p1 = aHi * bLo;
  const p2 = aLo * bHi;
  const p3 = aHi * bHi;
  const mid = p1 + p2 + Math.floor(p0 / 65536);
  const high = p3 + Math.floor(mid / 65536);
  return high >>> 0;
}

/** u32×u32の厳密な64bit積を {hi, lo}(ともにu32)で返す。BigIntなしの分割乗算。検証・非ホットパス用。 */
export function umul32to64(a: number, b: number): { hi: number; lo: number } {
  a >>>= 0;
  b >>>= 0;
  const aLo = a & 0xffff;
  const bLo = b & 0xffff;
  const p0 = aLo * bLo;
  const p1 = (a >>> 16) * bLo;
  const p2 = aLo * (b >>> 16);
  const low = (p0 + ((p1 + p2) % 65536) * 65536) % 4294967296;
  return { hi: mulHi32(a, b), lo: low >>> 0 };
}

/**
 * numerator/denom の厳密な整数floor(ともに非負・倍精度の安全範囲内)。
 * JSの浮動小数点除算は丸め誤差を含みうるため、1ステップの補正で吸収する
 * (本用途の値域では補正ループは通常0回で終わる)。
 */
function floorDivExact(numerator: number, denom: number): number {
  let q = Math.floor(numerator / denom);
  while (q * denom > numerator) q--;
  while ((q + 1) * denom <= numerator) q++;
  return q;
}

/** 格子点ハッシュ(u32)。既存のhashLatticeと同じ撹拌だが、[0,1)への正規化を行わずu32のまま返す。 */
export function hashU32(seed: number, x: number, z: number): number {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

/** オクターブ番号からのシード導出(u32)。 */
export function deriveSeedU32(seed: number, index: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b9)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** floor_euclidean(x/wave): wave>0前提。JSのMath.floorは負数に対しても数学的floorと一致する。 */
function floorEuclidean(x: number, wave: number): number {
  return Math.floor(x / wave);
}

/**
 * smoothQ: 格子座標gridと、smoothstep多項式をQ0.32へround_half_upしたtを返す。
 * バッチAPI(terrainField.tsのnoiseGridFor)がオクターブ格子を再利用するために公開している。
 */
export function smoothQ(x: number, wave: number): { grid: number; t: number } {
  const grid = floorEuclidean(x, wave);
  return { grid, t: quantiseTFromGrid(x, grid, wave) };
}

/**
 * lerpQ: 単調な向きに応じてtruncating(切り捨て)補間する。64bit積の上位32bit=floor(diff*t/2^32)を使う。
 * バッチAPI(terrainField.tsのnoiseGridFor)がハッシュ格子を再利用して各コーナーを補間するために公開している。
 */
export function lerpQ(a: number, b: number, t: number): number {
  if (b >= a) {
    return (a + mulHi32(b - a, t)) >>> 0;
  }
  return (a - mulHi32(a - b, t)) >>> 0;
}

/**
 * quantiseTFromGrid: smoothQのt(Q0.32のround_half_up)だけを、オブジェクト非生成で返す。
 * grid(=floor_euclidean(x/wave))は呼び出し側からもらう(valueNoiseQが1回のfloorEuclideanの
 * 結果をgrid算出とt算出の両方で使い回すため、ここでは再計算しない)。
 */
function quantiseTFromGrid(x: number, grid: number, wave: number): number {
  const r = x - grid * wave; // 0 <= r < wave
  const n = r * r * (3 * wave - 2 * r);
  const d = wave * wave * wave;
  const numerator2 = 2 * n * 4294967296 + d;
  return floorDivExact(numerator2, 2 * d) >>> 0;
}

/** 1オクターブぶんの値ノイズ(u32, Q0.32)。オブジェクト割り当てなしのホットパス。 */
function valueNoiseQ(seed: number, x: number, z: number, wave: number): number {
  const gx = floorEuclidean(x, wave);
  const gz = floorEuclidean(z, wave);
  const tx = quantiseTFromGrid(x, gx, wave);
  const tz = quantiseTFromGrid(z, gz, wave);
  const v00 = hashU32(seed, gx, gz);
  const v10 = hashU32(seed, gx + 1, gz);
  const v01 = hashU32(seed, gx, gz + 1);
  const v11 = hashU32(seed, gx + 1, gz + 1);
  const top = lerpQ(v00, v10, tx);
  const bottom = lerpQ(v01, v11, tx);
  return lerpQ(top, bottom, tz);
}

/** [波長, 重み] の組。正準定義: (40,8), (20,4), (10,2), (5,1)。 */
export const NOISE_WAVE_WEIGHTS: ReadonlyArray<readonly [wave: number, weight: number]> = [
  [40, 8],
  [20, 4],
  [10, 2],
  [5, 1],
];

/**
 * 合成ノイズ分子 N = 8*q0+4*q1+2*q2+q3 を返す。最大 15*(2^32-1) ≈ 6.44e10 なので
 * Number.isSafeIntegerの範囲(2^53)に収まり、64bit分割なしのプレーンなnumber演算で
 * 厳密に計算できる。
 */
export function compositeNoiseNumerator(seed: number, x: number, z: number): number {
  let n = 0;
  for (let i = 0; i < NOISE_WAVE_WEIGHTS.length; i++) {
    const [wave, weight] = NOISE_WAVE_WEIGHTS[i];
    const octaveSeed = deriveSeedU32(seed, i);
    n += valueNoiseQ(octaveSeed, x, z, wave) * weight;
  }
  return n;
}

/** water iff N < 9*2^30(64bit比較だが、Nはdoubleで厳密なのでそのまま比較できる)。 */
export const WATER_NUMERATOR_THRESHOLD = 9 * 2 ** 30;

/** 標高1..10の下限しきい値(標高0はこれらすべて未満)。 */
export const HEIGHT_NUMERATOR_THRESHOLDS: readonly number[] = [
  35433480192, 41290253778, 47147027363, 53003800949, 58860574534,
  64717348120, 70574121705, 76430895291, 82287668876, 88144442462,
];

export function heightFromNumerator(n: number): number {
  let height = 0;
  for (let i = 0; i < HEIGHT_NUMERATOR_THRESHOLDS.length; i++) {
    if (n >= HEIGHT_NUMERATOR_THRESHOLDS[i]) height = i + 1;
    else break;
  }
  return height;
}

export function isWaterNumerator(n: number): boolean {
  return n < WATER_NUMERATOR_THRESHOLD;
}

/** 検証用: Nを{hi,lo}(u32ペア)へ分割する。非ホットパス専用。 */
export function splitNumeratorHiLo(n: number): { hi: number; lo: number } {
  const hi = Math.floor(n / 4294967296);
  const lo = n - hi * 4294967296;
  return { hi, lo };
}
