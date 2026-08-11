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

/**
 * 地形プロファイル(新規ゲームで選ぶ「地形の起伏」)。
 *
 * ハッシュ・オクターブ・合成ノイズ分子Nの計算は**一切変えない**。変えるのは
 * 「Nを標高へ落とすしきい値テーブル」だけであり、これにより正準定義(1000件の
 * テストベクタ・TS/Rust/WGSLのバイト一致検証)の仕組みがそのまま生き続ける。
 */
export type TerrainProfile = 'flat' | 'normal' | 'mountain';

/** UI・テストが走査に使うプロファイル一覧。 */
export const TERRAIN_PROFILES: readonly TerrainProfile[] = ['flat', 'normal', 'mountain'];

/**
 * 隣接コーナー間の合成ノイズ分子Nの差の上界(整数、保守側に切り上げ済み)。
 *
 * 構成論拠: 各オクターブiの値ノイズは、u32の格子ハッシュ(値域 2^32-1)を
 * smoothstep(最大傾き 1.5/wave_i)で補間した連続かつ区分C1の関数なので、
 * x(またはz)方向に1進んだときの変化は高々 (2^32-1) * 1.5/wave_i。
 * N = Σ weight_i * q_i なので
 *   |ΔN| <= (2^32-1) * 1.5 * (8/40 + 4/20 + 2/10 + 1/5) = (2^32-1) * 1.2 < 1.2 * 2^32
 *         = 5,153,960,755.2
 * さらに整数化の丸め(lerpQの切り捨てが1オクターブあたり3回・重み合計15、
 * smoothQのtのround_half_up)の誤差を合わせても高々64しか増えないため、
 * 5,153,960,756 + 64 を上界として採用する。
 *
 * しきい値の間隔Sがこの上界以上であれば、隣接コーナーが2段以上またぐには
 * |ΔN| > S が必要となり矛盾する。よって「間隔 >= この上界」が
 * 1-Lipschitz(隣接コーナー標高差1以下)の構成保証になる。
 */
export const ADJACENT_NUMERATOR_BOUND = 5153960820;

/**
 * プロファイル別の標高1..10の下限しきい値(標高0はこれらすべて未満)。
 * 正準の分母は FULL = 15 * 2^32 = 64,424,509,440(=正規化ノイズ1.0)。
 *
 * - normal: 歴史的な既定(正準ドキュメントのテーブル)。T1=0.55*FULL、間隔≈FULL/11。
 *   バイト単位で不変(1000件のテストベクタがこの値に依存している)。
 * - mountain: T1=0.45*FULL へ引き下げ、間隔を上界近く(5.2e9 > 5,153,960,820)まで
 *   詰めて起伏を密にする。標高1以上のコーナーが約63%になり、標高5〜7の高山も出る。
 * - flat: T1=0.675*FULL へ引き上げ、間隔を7.8e9へ広げる。標高1以上は約8%で
 *   広大な平野が支配的になり、2段以上の丘はごく稀。
 */
const HEIGHT_THRESHOLDS_BY_PROFILE: Readonly<Record<TerrainProfile, readonly number[]>> = {
  flat: [
    43486543872, 51286543872, 59086543872, 66886543872, 74686543872,
    82486543872, 90286543872, 98086543872, 105886543872, 113686543872,
  ],
  normal: [
    35433480192, 41290253778, 47147027363, 53003800949, 58860574534,
    64717348120, 70574121705, 76430895291, 82287668876, 88144442462,
  ],
  mountain: [
    28991029248, 34191029248, 39391029248, 44591029248, 49791029248,
    54991029248, 60191029248, 65391029248, 70591029248, 75791029248,
  ],
};

/** プロファイルのしきい値テーブル。未知の値はnormalへフォールバックする。 */
export function heightThresholdsFor(profile: TerrainProfile): readonly number[] {
  return HEIGHT_THRESHOLDS_BY_PROFILE[profile] ?? HEIGHT_THRESHOLDS_BY_PROFILE.normal;
}

/** 標高1..10の下限しきい値(既定=normalプロファイル)。 */
export const HEIGHT_NUMERATOR_THRESHOLDS: readonly number[] = HEIGHT_THRESHOLDS_BY_PROFILE.normal;

/** しきい値テーブルを直接受け取る標高導出(ホットパス用: テーブル解決を呼び出し側で済ませる)。 */
export function heightFromNumeratorWith(n: number, thresholds: readonly number[]): number {
  let height = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (n >= thresholds[i]) height = i + 1;
    else break;
  }
  return height;
}

/** プロファイル指定の標高導出。 */
export function heightFromNumeratorFor(n: number, profile: TerrainProfile): number {
  return heightFromNumeratorWith(n, heightThresholdsFor(profile));
}

/** 標高導出(既定=normalプロファイル。正準テストベクタが参照する経路)。 */
export function heightFromNumerator(n: number): number {
  return heightFromNumeratorWith(n, HEIGHT_NUMERATOR_THRESHOLDS);
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
