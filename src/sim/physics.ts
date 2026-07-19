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

// 将来の車種差別化(express/commuter)を見据えた定数テーブル。TrainDataには持たせない。
// enginePower/maxTractiveEffortは、既存の走行感(空車2両編成・最高100km/h、発進直後の
// 加速度が旧ACCEL_KMH_S=15km/h/s相当)を概ね維持するように調整した値。
export const TRAIN_SPECS: Record<'commuter' | 'express', TrainSpec> = {
  commuter: { enginePower: 1200, carMassEmpty: 30, maxTractiveEffort: 260 },
  express: { enginePower: 2000, carMassEmpty: 34, maxTractiveEffort: 320 },
};

export const DEFAULT_TRAIN_TYPE: keyof typeof TRAIN_SPECS = 'commuter';

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
 * 戻り値の単位は m/s²(brakingは負値)。
 */
export function computeAcceleration(
  input: AccelerationInput,
  mode: 'accelerating' | 'braking',
  fallbackDecelKmhS: number
): number {
  if (mode === 'braking') {
    return -fallbackDecelKmhS / 3.6;
  }

  const { spec, cars, passengers, speedKmh } = input;
  const massKg = computeMassKg(spec, cars, passengers);
  const speedMs = Math.max(0, speedKmh) / 3.6;

  const powerW = spec.enginePower * 1000;
  const maxTeN = spec.maxTractiveEffort * 1000;

  // F=P/v。停止付近(v→0)は発散するため、キックオフ牽引力(粘着限界)で代用する。
  const forceN = speedMs < KICKOFF_SPEED_MS ? maxTeN : Math.min(maxTeN, powerW / speedMs);

  const rollingN = massKg * GRAVITY_MS2 * ROLLING_RESISTANCE_COEF;
  const airN = AIR_DRAG_COEF_PER_CAR * cars * speedMs * speedMs;
  const resistanceN = rollingN + airN;

  const netForceN = forceN - resistanceN;
  return netForceN / massKg;
}

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
