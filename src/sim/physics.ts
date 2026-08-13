// OpenTTD Realistic 加速モデルの簡易移植。
// progress/openttd-source-notes.md C節(GroundVehicle::GetAcceleration/DoUpdateSpeed)の
// 式・定数構造を参考に、GPLコードはコピーせず「力→加速度=F/m」の構造だけを再実装する。
// 1セル=30m・km/h基準の値になるよう係数を調整している。

export interface TrainSpec {
  /** 出力 (kW) */
  enginePower: number;
  /** 空車時の1両あたり質量 (t) */
  carMassEmpty: number;
  /** 粘着限界としての最大牽引力 (kN) */
  maxTractiveEffort: number;
}

// 車種(TrainModelId)。TrainData.model(types.ts)に持たせる購入時の選択肢。
// 'commuter'が既定かつ旧セーブ互換(model省略=通勤形として読む。trainModelOfを参照)。
export type TrainModelId = 'commuter' | 'suburban' | 'express';

export interface TrainModel {
  /** UI表示名(日本語)。 */
  name: string;
  /** 最高速度 (km/h)。レール種別capや他の速度上限とはmin合成で効く。 */
  maxSpeedKmh: number;
  /** 常用減速度 (km/h/s)。EMERGENCY_DECEL_KMH_S(非常制動)は車種によらず共通のまま。 */
  serviceDecelKmhS: number;
  /** 加速度計算(computeAcceleration)に渡すスペック。 */
  spec: TrainSpec;
  /** 新造価格の倍率。trainCostForProtectedの結果にさらに乗算する(sim/economy.ts)。 */
  priceMultiplier: number;
}

// 3車種の値。commuter(通勤形)は最高速控えめ・加減速が速い、suburban(近郊形)は
// バランス型、express(特急形)は最高速が高い代わりに加減速が緩やか、というOpenTTD
// realisticモデル(F/m構造)上の描き分け。commuterのenginePower/maxTractiveEffortは
// 旧TRAIN_SPECS.commuterの値(1200kW/260kN)から底上げした(旧値より加減速が速いのが
// 意図した挙動で、既存の走行感の保存は狙っていない)。
export const TRAIN_MODELS: Record<TrainModelId, TrainModel> = {
  commuter: {
    name: '通勤形',
    maxSpeedKmh: 100,
    serviceDecelKmhS: 24,
    spec: { enginePower: 1400, carMassEmpty: 30, maxTractiveEffort: 300 },
    priceMultiplier: 1.0,
  },
  suburban: {
    name: '近郊形',
    maxSpeedKmh: 120,
    serviceDecelKmhS: 20,
    spec: { enginePower: 1600, carMassEmpty: 32, maxTractiveEffort: 280 },
    priceMultiplier: 1.3,
  },
  express: {
    name: '特急形',
    maxSpeedKmh: 130,
    serviceDecelKmhS: 18,
    spec: { enginePower: 2000, carMassEmpty: 34, maxTractiveEffort: 320 },
    priceMultiplier: 1.8,
  },
};

export const DEFAULT_TRAIN_MODEL: TrainModelId = 'commuter';

/** TrainData.modelからTrainModelを解決する。undefined(旧セーブ・未選択)は通勤形扱い。 */
export function trainModelOf(model: TrainModelId | undefined): TrainModel {
  return TRAIN_MODELS[model ?? DEFAULT_TRAIN_MODEL];
}

/** 乗客1人あたりの質量 (t)。実測より丸めた概算値。 */
export const PASSENGER_MASS_T = 0.08;

// 転がり抵抗係数(鋼対鋼、無次元の概算値)。
const ROLLING_RESISTANCE_COEF = 0.0035;
const GRAVITY_MS2 = 9.8;
// 空気抵抗係数(N・s²/m²、1両あたり)。連結数が増えるほど全体の抵抗も増える単純化モデル。
const AIR_DRAG_COEF_PER_CAR = 4;
// 発進時のキックオフ牽引力(粘着限界)が有効になる速度のしきい値 (m/s)。
const KICKOFF_SPEED_MS = 1;

export interface AccelerationInput {
  spec: TrainSpec;
  cars: number;
  passengers: number;
  speedKmh: number;
}

export function computeMassKg(spec: TrainSpec, cars: number, passengers: number): number {
  const massT = spec.carMassEmpty * cars + passengers * PASSENGER_MASS_T;
  return massT * 1000;
}

/**
 * OpenTTD Realisticモデルの構造(牽引力−抵抗→F/m=加速度)を再実装した加速度計算。
 * - mode='accelerating': 牽引力(粘着限界でクランプ)から転がり抵抗・空気抵抗(速度の2乗項)を
 *   差し引いた正味力を質量で割る。乗客が多いほど質量が増え加速が鈍る。
 * - mode='braking': OpenTTD同様、既存の一定減速度(fallbackDecelKmhS)をそのまま採用する。
 * - mode='coasting'(PM3): デッドセクション通過中の惰行。牽引力ゼロ(forceN=0)のまま
 *   転がり抵抗・空気抵抗だけを差し引く。既存の'accelerating'の抵抗項をそのまま
 *   再利用しており、新しい減速モデルを追加したわけではない(design decision 4:
 *   「passive dragがあるならそれで減速、無いならゼロ加速度」に対応)。
 * tractionFactor(PM4): き電区間の在線数が容量を超えたときの電圧降下の離散近似
 * (feeding.tsのOVERLOAD_ACCEL_FACTOR)。牽引力(forceN)にだけ掛ける、既定1(無影響)。
 * ブレーキ・惰行の抵抗項には掛けない(design decision 4「traction only」)。
 * 戻り値の単位は m/s²(braking/coastingは負値または0)。
 */
export function computeAcceleration(
  input: AccelerationInput,
  mode: 'accelerating' | 'braking' | 'coasting',
  fallbackDecelKmhS: number,
  tractionFactor = 1
): number {
  if (mode === 'braking') {
    return -fallbackDecelKmhS / 3.6;
  }

  const { spec, cars, passengers, speedKmh } = input;
  const massKg = computeMassKg(spec, cars, passengers);
  const speedMs = Math.max(0, speedKmh) / 3.6;

  const rollingN = massKg * GRAVITY_MS2 * ROLLING_RESISTANCE_COEF;
  const airN = AIR_DRAG_COEF_PER_CAR * cars * speedMs * speedMs;
  const resistanceN = rollingN + airN;

  if (mode === 'coasting') {
    return -resistanceN / massKg;
  }

  const powerW = spec.enginePower * 1000;
  const maxTeN = spec.maxTractiveEffort * 1000;

  // F=P/v。停止付近(v→0)は発散するため、キックオフ牽引力(粘着限界)で代用する。
  const forceN = (speedMs < KICKOFF_SPEED_MS ? maxTeN : Math.min(maxTeN, powerW / speedMs)) * tractionFactor;

  const netForceN = forceN - resistanceN;
  return netForceN / massKg;
}

/**
 * ブレーキのジャーク(加加速度)上限 (m/s³)。減速度をこの割合より速く変化させない。
 * 実車の常用ブレーキは指令から込め終わりまでに時間がかかるため、減速度が0から
 * 一定値へ階段状に跳ぶと「ぎこちない」当たりの強い停車に見える。
 */
// DECEL_KMH_S=20km/h/s(≒5.56 m/s²)を約0.9秒かけて込め切る値。
// 小さくしすぎるとブレーキ開始が極端に早まり、大きくすると階段状の当たりに戻る。
export const BRAKE_JERK_MS3 = 6.0;

/**
 * 「残り距離 distanceM で停止するために、今許される速度」(km/h)。
 *
 * 単純な sqrt(2ad) は「減速度aが即座に立ち上がる」前提のため、ブレーキ込め中の
 * 距離を食い潰してしまい、込め終わった時点では既に手遅れ→急制動、という
 * ぎこちない挙動になる。ここでは「まだ立ち上げていない減速度ぶん(a − 現在の減速度)を
 * ジャークjで立ち上げる」のに必要な余分距離を織り込む:
 *
 *   d = v²/(2a) + v·k,  k = (a − currentDecel) / (2j)
 *   ⟹ v = a·( sqrt(k² + 2d/a) − k )
 *
 * - ブレーキ緩解中(currentDecel=0)は最大の余裕を見てブレーキ開始を早める
 * - ブレーキ込め終わり(currentDecel=a)では k=0 となり sqrt(2ad) に一致する。
 *   これが重要で、終盤にkが残ると v∝d の線形則になり、時間軸では指数的漸近=
 *   停止直前に延々と這い続ける「だらだらクロール」を生んでしまう。
 */
export function permittedSpeedKmh(
  distanceM: number,
  decelMs2: number,
  jerkMs3: number,
  currentDecelMs2 = 0
): number {
  const d = Math.max(0, distanceM);
  if (decelMs2 <= 0) return 0;
  if (!(jerkMs3 > 0)) return Math.sqrt(2 * decelMs2 * d) * 3.6;

  const deficit = Math.max(0, decelMs2 - Math.max(0, currentDecelMs2));
  const k = deficit / (2 * jerkMs3);
  const v = decelMs2 * (Math.sqrt(k * k + (2 * d) / decelMs2) - k);
  return v * 3.6;
}

/**
 * permittedSpeedKmh の逆関数。速度 v から「ジャークで減速度を立ち上げつつ停止する」
 * のに必要な距離(m)を返す:  d = v²/(2a) + v·a/(2j)
 * 速度制御と予約延長の判定で同じ制動距離を使うために切り出してある。
 */
export function brakingDistanceM(speedKmh: number, decelMs2: number, jerkMs3: number): number {
  const v = Math.max(0, speedKmh) / 3.6;
  if (decelMs2 <= 0) return Infinity;
  const jerkAllowance = jerkMs3 > 0 ? (v * decelMs2) / (2 * jerkMs3) : 0;
  return (v * v) / (2 * decelMs2) + jerkAllowance;
}

/** 減速度(m/s²)をジャーク上限に従って desired へ近づける。 */
export function rampDecel(
  currentMs2: number,
  desiredMs2: number,
  jerkMs3: number,
  dt: number
): number {
  const maxStep = Math.max(0, jerkMs3) * Math.max(0, dt);
  const diff = desiredMs2 - currentMs2;
  if (Math.abs(diff) <= maxStep) return desiredMs2;
  return currentMs2 + Math.sign(diff) * maxStep;
}

/**
 * 軌道(何キロレール、progress/play-modes-plan.md「軌道」)のレール種別ごとの速度上限(km/h)。
 * 制動曲線(permittedSpeedKmh/brakingDistanceM)がここを直接消費するため物理定数として
 * physics.tsに置く(コスト・軸重はゲームルール寄りなのでeconomy.ts/gameRules.tsに分離)。
 * 60kgレールは無制限(=線区の最高速度がそのまま上限になる)。
 */
export const RAIL_WEIGHT_SPEED_CAP_KMH: Record<37 | 50 | 60, number> = {
  37: 70,
  50: 110,
  60: Infinity,
};

/** レール種別から速度上限を引く。省略(undefined)は50kgN扱い(呼び出し側の既定と揃える)。 */
export function railWeightSpeedCapKmh(weight: 37 | 50 | 60 | undefined): number {
  return RAIL_WEIGHT_SPEED_CAP_KMH[weight ?? 50];
}

/**
 * 動力方式ごとの軸重(t、リアリスティックのみ)。購入時にTrainData.axleLoadTへ書き込む
 * (economy.ts/useGameLogicの購入処理)。将来、機関車ごとに異なる軸重を持たせる余地がある
 * ので定数テーブルはここで単純に動力方式にだけ紐づける。
 */
export const AXLE_LOAD_T_BY_POWER: Record<'diesel' | 'electric' | 'electric-ac' | 'electric-acdc', number> = {
  diesel: 14,
  electric: 12,
  'electric-ac': 12,
  'electric-acdc': 13,
};

// OpenTTD 1tick相当(約1/30秒)を単位に減衰を刻む。
const OVERSPEED_TICK_S = 1 / 30;

/**
 * OpenTTD DoUpdateSpeedの「最高速度超過時は瞬時にクランプせず、現在速度の1/10ずつ
 * 緩やかに落とす」挙動を再現する。targetKmh以下ならそのまま返す。
 */
export function applyOverspeedDecay(currentKmh: number, targetKmh: number, dt: number): number {
  if (currentKmh <= targetKmh) return currentKmh;
  const ticks = Math.max(1, Math.round(dt / OVERSPEED_TICK_S));
  let v = currentKmh;
  for (let i = 0; i < ticks; i++) {
    v = Math.max(targetKmh, v - v / 10);
  }
  return v;
}
