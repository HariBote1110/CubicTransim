// 経済システムの定数と建設コスト計算。
// 純粋関数のみ。React/THREE には依存しない。
import { toKey } from '../utils';
import type { CellData, PlatformDoorType, TownData, TrainPower, TrainProtection, RailWeight } from '../types';
import type { TerrainField } from './terrainField';
import { applyRailPathDetailed, resolveGroundRailPlan, MAX_BRIDGE_LENGTH, type GroundRailCellRole } from './construction';
import { SLOPE_RAIL_COST_MULTIPLIER } from './slopes';
import { trainModelOf, type TrainModelId } from './physics';
import type { SimWorld } from './simulation';

export const STARTING_MONEY = 50_000;

// ゲーム内暦: シミュレーション秒→日→月の換算。
export const SECONDS_PER_DAY = 10; // シミュレーション秒
export const DAYS_PER_MONTH = 30;
const MONTHS_PER_YEAR = 12;

export interface GameDate {
  year: number;
  month: number;
  day: number;
}

// elapsed(シミュレーション累積秒)から年月日を導出する。1年1月1日開始。
export function clockToDate(elapsed: number): GameDate {
  const dayIndex = Math.floor(elapsed / SECONDS_PER_DAY);
  const monthIndex = Math.floor(dayIndex / DAYS_PER_MONTH);
  const year = Math.floor(monthIndex / MONTHS_PER_YEAR) + 1;
  const month = (monthIndex % MONTHS_PER_YEAR) + 1;
  const day = (dayIndex % DAYS_PER_MONTH) + 1;
  return { year, month, day };
}

// elapsedから「何ヶ月目(0始まりの絶対月インデックス)」を導出する(月跨ぎ検出用の内部ヘルパー)。
export function monthIndexOf(elapsed: number): number {
  const dayIndex = Math.floor(elapsed / SECONDS_PER_DAY);
  return Math.floor(dayIndex / DAYS_PER_MONTH);
}

// elapsedから「何日目(0始まりの絶対日インデックス)」を導出する(日跨ぎ検出用の内部ヘルパー)。
// 町の輸送力チェック(resolveTownSpawnTick)など、月次より細かい粒度のティックに使う。
export function dayIndexOf(elapsed: number): number {
  return Math.floor(elapsed / SECONDS_PER_DAY);
}

// 絶対月インデックスから年月を導出する(stepWorldがmonthEndイベントの年月を求めるのに使う)。
export function yearMonthOfIndex(monthIndex: number): { year: number; month: number } {
  const year = Math.floor(monthIndex / MONTHS_PER_YEAR) + 1;
  const month = (monthIndex % MONTHS_PER_YEAR) + 1;
  return { year, month };
}

// 維持費(月額)
export const UPKEEP_PER_CAR = 250; // /両/月
export const RAIL_UPKEEP = 2; // /セル/月(橋・トンネルも同額)
export const STATION_UPKEEP = 100; // /駅/月
export const DEPOT_UPKEEP = 100; // /棟/月

// 月次の維持費合計を計算する(純粋関数)。列車の維持費は編成両数に比例する。
export function calculateUpkeep(world: SimWorld): number {
  let railCells = 0;
  let depotCount = 0;
  for (const cell of world.railMap.values()) {
    if (cell.type === 'rail') railCells += 1;
    else if (cell.type === 'depot') depotCount += 1;
  }
  const trainUpkeep = world.trains.reduce((sum, t) => sum + (t.cars ?? 2) * UPKEEP_PER_CAR, 0);
  return (
    trainUpkeep +
    railCells * RAIL_UPKEEP +
    world.stations.size * STATION_UPKEEP +
    depotCount * DEPOT_UPKEEP
  );
}

// 月次収支台帳
export interface MonthlyLedger {
  year: number;
  month: number;
  fares: number;
  construction: number;
  upkeep: number;
  accidents: number;
  /** 借入残高に対して月末に支払う利息。 */
  interest: number;
}

export const RAIL_COST = 100; // 1セルあたり(平地)
export const STATION_COST = 1_000;
export const DEPOT_COST = 2_000;
export const SIGNAL_COST = 200;
// PM4: 変電所。車庫より高価(¥8,000、値は「あったら楽しい」判断)。
export const SUBSTATION_COST = 8_000;
export const TRAIN_COST = 5_000; // 新造時(2両編成)の価格
export const CAR_COST = 2_000; // 増結1両あたり
export const CAR_REFUND = 1_000; // 解結1両あたりの払い戻し

// PM2: 電化(直流前提の単純ON/OFF)の追加コスト。架線設備費として1セルあたり
// RAIL_COSTの50%増しにする(値は「あったら楽しい」判断、progress/play-modes-plan.md)。
export const ELECTRIFICATION_COST_MULTIPLIER = 0.5;

// 地形編集(盛土/切土)の1セル・1段あたりのコスト。線路(RAIL_COST=100)の半分にして、
// OpenTTD同様「整地してから敷くほうがトンネル(8倍)・橋(5倍)より安いが、
// 広範囲の造成は財布に響く」バランスにする。
export const TERRAIN_EDIT_COST = 50;

// 地形編集のコスト。cellSteps=変化したセル段数(applyTerrainEditのchangedCells件数。
// 1回の編集で各セルの変化は常に±1段なので件数=総段数)。
export function costOfTerrainEdit(cellSteps: number): number {
  return cellSteps * TERRAIN_EDIT_COST;
}

// PM2: 電化を選んだ場合の追加費用。cellCountは建設対象セル数(地平/高架/地下いずれも
// 同一の1セルあたり単価とする、電化設備費を線路本体のコストと分離した単純化)。
export function costOfElectrification(cellCount: number): number {
  return cellCount * RAIL_COST * ELECTRIFICATION_COST_MULTIPLIER;
}

// 軌道(何キロレール、リアリスティックのみ)。重いレールほど高価にする。
// 37kg(軽量・安価)/50kgN(標準・基準単価)/60kg(重量・高価)。線路本体の単価(baseCost)に
// 乗算する倍率とし、electrification(架線設備費、加算)とは独立に扱う。
export const RAIL_WEIGHT_COST_MULTIPLIER: Record<RailWeight, number> = {
  37: 0.8,
  50: 1.0,
  60: 1.3,
};

/** レール種別のコスト倍率。省略時は50kgN(倍率1.0)。 */
export function costMultiplierForRailWeight(weight?: RailWeight): number {
  return RAIL_WEIGHT_COST_MULTIPLIER[weight ?? 50];
}

// PM3: 交流専用車は直流車+20%、交直流両用車は+50%(値は「あったら楽しい」判断、
// progress/play-modes-plan.md PM3。実物同様、交流は車両側が複雑・高価になる)。
export const AC_TRAIN_PRICE_MULTIPLIER = 1.2;
export const ACDC_TRAIN_PRICE_MULTIPLIER = 1.5;

// PM3: 動力方式ごとの新造価格。'electric'(直流専用)/'diesel'はTRAIN_COSTのまま、
// 'electric-ac'/'electric-acdc'は上記倍率を掛ける。
export function trainCostFor(power: TrainPower): number {
  if (power === 'electric-ac') return Math.round(TRAIN_COST * AC_TRAIN_PRICE_MULTIPLIER);
  if (power === 'electric-acdc') return Math.round(TRAIN_COST * ACDC_TRAIN_PRICE_MULTIPLIER);
  return TRAIN_COST;
}

// PM2 Stage B: 改軌(既存線路の軌間変換)1セルあたりの費用。撤去(無料)+再敷設
// (RAIL_COST)より安くする「あったら楽しい」判断で、RAIL_COSTの60%とした
// (60円/セル、100円で作り直すより確実に得だが工事費として実感できる程度の割引)。
export const REGAUGE_COST_PER_CELL = RAIL_COST * 0.6;

// 改軌のコスト。cellCountは実際に軌間が変わったセル数(construction.tsの
// applyRegaugePathが確定させたもの。既に目的軌間のセルは無料でスキップされ課金対象外)。
export function costOfRegauge(cellCount: number): number {
  return cellCount * REGAUGE_COST_PER_CELL;
}

// 水上は「橋」、山岳は「トンネル」としてRAIL_COSTに乗算する倍率
export const BRIDGE_COST_MULTIPLIER = 5;
export const TUNNEL_COST_MULTIPLIER = 8;
// 立体交差(upper)になるセルに乗算する倍率。橋の橋桁にも同じ倍率を使う。
export const OVERPASS_COST_MULTIPLIER = 4;

// 橋の全長(橋台含むセル数)の上限。construction.tsのMAX_BRIDGE_LENGTHをそのまま再エクスポートする
// (UI・経済計算側からはeconomy.tsを窓口にするため)。
export { MAX_BRIDGE_LENGTH };

export const PASSENGER_SPAWN_RATE = 0.5; // 人/秒/駅(demandFactor=1のときの基準値)
export const STATION_WAITING_CAP = 200;
export const CAPACITY_PER_CAR = 50; // 定員=cars×CAPACITY_PER_CAR
export const FARE_PER_TILE = 2;

// 街の旅客需要が駅に及ぶ最大距離(タイル)。これを超えると影響0になる。
export const TOWN_INFLUENCE_RADIUS = 10;

// 駅の立地需要係数。周辺の街の人口と距離から算出する。
// 各街ごとに (population / 1000) × max(0, 1 - distance / TOWN_INFLUENCE_RADIUS) を合算する。
export function demandFactor(
  stationCentre: { x: number; z: number },
  towns: TownData[]
): number {
  let total = 0;
  for (const town of towns) {
    const dist = Math.hypot(stationCentre.x - town.centre.x, stationCentre.z - town.centre.z);
    const proximity = Math.max(0, 1 - dist / TOWN_INFLUENCE_RADIUS);
    total += (town.population / 1000) * proximity;
  }
  return total;
}

// ホームドア(駅単位・一括払い)
export const PLATFORM_DOOR_STANDARD_COST = 3_000;
export const PLATFORM_DOOR_FULLSCREEN_COST = 8_000;

// 人身事故: 停車1回あたりの発生確率とその影響
export const ACCIDENT_BASE_CHANCE = 0.01;
export const ACCIDENT_DOOR_MODIFIER = {
  none: 1.0,
  standard: 0.05,
  fullscreen: 0,
} as const;
export const ACCIDENT_HALT_DURATION = 60; // シミュレーション秒
export const ACCIDENT_PENALTY = 5_000;

// S3(保安装置、progress/signalling-plan.md)。地上設備の1セルあたり追加コスト
// (敷設した信号セルのみ課金。線路本体・信号本体のコストとは別建て)。
export const PROTECTION_COST: Record<TrainProtection, number> = {
  'ats-s': 10,
  'ats-p': 30,
  atc: 60,
  cbtc: 100,
};

// S3: 車上装置の価格倍率。基準額(trainCostForの結果)に掛ける。AC/ACDCの倍率とは
// 乗算で合成する(=交流用CBTC車なら AC_TRAIN_PRICE_MULTIPLIER × 1.5、のように積み上がる)。
export const PROTECTION_TRAIN_PRICE_MULTIPLIER: Record<TrainProtection, number> = {
  'ats-s': 1.05,
  'ats-p': 1.15,
  atc: 1.3,
  cbtc: 1.5,
};

// S3: 信号冒進(SPAD)の発生確率。停止信号への進入待ちに入った瞬間、1回だけ判定する
// (progress/signalling-plan.mdの「事故システムと接続する」設計どおり)。ATS-Sは
// 警報のみ(確認扱いで通過できてしまう)ため完全には防げない。ATS-P/ATC/CBTCは
// パターン照査・移動閉塞のため確実に止まる=0%とする。
export const SPAD_CHANCE: Record<'none' | TrainProtection, number> = {
  none: 0.02,
  'ats-s': 0.005,
  'ats-p': 0,
  atc: 0,
  cbtc: 0,
};

// S3: 保安装置の強さの順位(弱いほど小さい)。ATS-P/ATCはSPAD確率が同じ(0%)なので
// 順位が同着でも判定結果には影響しない。「弱い方」判定(weakerProtection)専用。
const PROTECTION_RANK: Record<'none' | TrainProtection, number> = {
  none: 0,
  'ats-s': 1,
  'ats-p': 2,
  atc: 2,
  cbtc: 3,
};

/** 地上設備と車上装置のうち弱い方(=effective protection)を返す。未設定は'none'扱い。 */
export function weakerProtection(
  a: TrainProtection | undefined,
  b: TrainProtection | undefined
): 'none' | TrainProtection {
  const an = a ?? 'none';
  const bn = b ?? 'none';
  return PROTECTION_RANK[an] <= PROTECTION_RANK[bn] ? an : bn;
}

// S3: 動力方式の価格(trainCostFor)に保安装置の倍率を乗算合成する。
// 車種(TRAIN_MODELS、physics.ts)のpriceMultiplierも渡せば、動力方式×保安装置×車種の
// 3つの倍率をすべて積み上げて丸める(丸めは最後に一度だけ)。modelを省略した場合は
// 通勤形(priceMultiplier=1.0)扱いなので、既存の呼び出し元は挙動が変わらない。
export function trainCostForProtected(
  power: TrainPower,
  protection?: TrainProtection,
  model?: TrainModelId
): number {
  const base = trainCostFor(power);
  const protectionMultiplier = protection ? PROTECTION_TRAIN_PRICE_MULTIPLIER[protection] : 1;
  const modelMultiplier = trainModelOf(model).priceMultiplier;
  return Math.round(base * protectionMultiplier * modelMultiplier);
}

// 車庫での列車売却(在籍中の列車のみ)の払い戻し額。CAR_REFUND/CAR_COST(=50%)と
// 同じ比率を編成全体に適用する: 基準2両ぶんの価格(baseCost、power/protectionを
// 反映済みのtrainCostForProtectedの結果)に、増結ぶん(cars-2両、負にはならない)を
// CAR_COST換算で足してから半額にする。
export function trainSellRefund(baseCost: number, cars: number): number {
  return Math.round(0.5 * trainTotalCost(baseCost, cars));
}

// 編成として組み上がった状態での総額(基準2両ぶんのbaseCost + 増結ぶんのCAR_COST)。
// 複製(cloneTrain)・売却(trainSellRefund)いずれもこれを土台にする。
export function trainTotalCost(baseCost: number, cars: number): number {
  const extraCars = Math.max(0, cars - 2);
  return baseCost + extraCars * CAR_COST;
}

// S3: 保安装置を選んだ場合の地上設備の追加費用(建設セル数×単価)。
export function costOfProtection(cellCount: number, protection?: TrainProtection): number {
  if (!protection) return 0;
  return cellCount * PROTECTION_COST[protection];
}

// 'bridge'は旧・固定長橋の後方互換用(applyBridgeが薄いラッパーとして残っているため)。
// 高架専用ツール('elevated'/'elevated-station')は廃止し、'rail'/'station'がlevel引数
// (buildPreview.ts参照)に従って高架を建設する形に統合した。
export type ConstructionMode = 'rail' | 'station' | 'depot' | 'signal' | 'bridge' | 'substation';

// 自由な高架線(applyElevatedPath)のコスト。坂になるセルはRAIL_COST、橋桁(高架)に
// なるセルはRAIL_COST×OVERPASS_COST_MULTIPLIER。内訳(rampCount/overpassCount)は
// construction.tsのresolveElevatedPathEnd/planElevatedPathが確定させたものを
// 呼び出し側(buildPreview.ts)から渡してもらう(判定ロジックの二重実装を避けるため)。
export function costOfElevatedPath(rampCellCount: number, overpassCellCount: number): number {
  return rampCellCount * RAIL_COST + overpassCellCount * RAIL_COST * OVERPASS_COST_MULTIPLIER;
}

// 高架駅タイル1枚のコスト。立体交差の橋桁を兼ねるぶん通常の駅より割高になる。
export const ELEVATED_STATION_COST = STATION_COST * OVERPASS_COST_MULTIPLIER;

// P8a: 地下線・地下駅のコスト倍率。underground-design.md「5. コスト」の初版値
// (「制約がない代わりに高い」の原則)。地下は町タイル・地形種別の制約をほぼ受けない
// 代わりに、高架より高い倍率にする。
export const UNDERGROUND_RAIL_COST_MULTIPLIER = 6;
export const UNDERGROUND_STATION_COST_MULTIPLIER = 3;

// 自由な地下線(applyUndergroundPath)のコスト。design docの通り、坂(掘割ランプ)/
// 地下線(span)を区別せず経路の全セルにRAIL_COST×6を課す(applyElevatedPathの
// 「坂と橋桁で倍率が違う」構成とは異なる、地下ならではの単純化)。
export function costOfUndergroundPath(cellCount: number): number {
  return cellCount * RAIL_COST * UNDERGROUND_RAIL_COST_MULTIPLIER;
}

// 地下駅タイル1枚のコスト。design docの通りELEVATED_STATION_COST(高架駅コスト)を
// さらに3倍する(地下駅は「立体交差の橋桁を兼ねる高架駅」よりもさらに割高)。
export const UNDERGROUND_STATION_COST = ELEVATED_STATION_COST * UNDERGROUND_STATION_COST_MULTIPLIER;

// 地平(level 0)の線路が、浮いた高架の端タイルに自動接続する坂を含む場合のコスト。
// 坂になるセルはRAIL_COST(4倍にはならない。あくまで登り降りの坂であり橋桁ではないため)、
// それ以外の平坦なセルは従来通り地形(水域=橋/山岳=隧道)の倍率つきRAIL_COSTを使う。
// 内訳(どのセルが坂か)はconstruction.tsのplanElevatedPath(level=0)が確定させたものを
// 呼び出し側(buildPreview.ts/useGameLogic.ts)から渡してもらう(判定ロジックの
// 二重実装を避けるため)。
export function costOfGroundPathWithRamps(
  path: { x: number; z: number }[],
  field: TerrainField,
  rampFlags: boolean[]
): number {
  return path.reduce((sum, cell, i) => {
    if (rampFlags[i]) return sum + RAIL_COST;
    const t = field.terrainTypeAt(cell.x, cell.z);
    const terrainMultiplier = t === 'water' ? BRIDGE_COST_MULTIPLIER : t === 'mountain' ? TUNNEL_COST_MULTIPLIER : 1;
    return sum + RAIL_COST * terrainMultiplier;
  }, 0);
}

// P7b: resolveGroundRailPlan(construction.ts)が確定させたセルごとの建設方法(勾配追従の
// flat/incline、またはtunnel)から建設コストを計算する。tunnelはTUNNEL_COST_MULTIPLIER、
// inclineはSLOPE_RAIL_COST_MULTIPLIER、水域(flatのまま橋になる場合)はBRIDGE_COST_MULTIPLIER。
// 内訳の判定ロジック自体はconstruction.ts側(resolveGroundRailPlan)に一本化し、ここでは
// その結果に価格を付けるだけに留める(UI・呼び出し側にルールを書き写さないため)。
export function costOfGroundRailPlan(
  path: { x: number; z: number }[],
  field: TerrainField,
  plan: GroundRailCellRole[]
): number {
  return path.reduce((sum, cell, i) => {
    const role = plan[i];
    if (role.kind === 'tunnel') return sum + RAIL_COST * TUNNEL_COST_MULTIPLIER;
    if (role.slope === 'incline') return sum + RAIL_COST * SLOPE_RAIL_COST_MULTIPLIER;
    const t = field.terrainTypeAt(cell.x, cell.z);
    return sum + RAIL_COST * (t === 'water' ? BRIDGE_COST_MULTIPLIER : 1);
  }, 0);
}

// PM3フォローアップ: デッドセクション失速(progress/play-modes-plan.md)。
// electrification='boundaries'/'feeding'のときのみ、境界通過中に速度が
// ほぼ0まで落ちた電車は失速状態になる。STALL_RECOVERY_SECONDS秒待つと
// 救援(牽引車の応援、という体の演出)が来て走行を再開できる代わりに
// STALL_RESCUE_COSTを1回だけ課金する。値は「あったら楽しい」判断。
export const STALL_RECOVERY_SECONDS = 15;
export const STALL_RESCUE_COST = 3_000;

// 事故発生確率 = 基本確率 × ドア種別による係数 × 混雑係数(待ち0で0.5倍、満杯で1.5倍)
export function calculateAccidentChance(doorType: PlatformDoorType, waiting: number): number {
  const congestionFactor = 0.5 + waiting / STATION_WAITING_CAP;
  return ACCIDENT_BASE_CHANCE * ACCIDENT_DOOR_MODIFIER[doorType] * congestionFactor;
}

// path上に建設する際のコストを計算する。
// rail はセル数に比例、station/depot/signal は単セル操作なので単価固定。
// rail について path と terrain を渡すと、セルごとの地形(水域=橋/山岳=トンネル)を
// 反映した倍率込みの合計コストを返す。渡さない場合は従来通り平地扱いの単純計算。
// railMap も渡すと、この path適用で立体交差(upper)になるセルにも
// OVERPASS_COST_MULTIPLIERを掛ける(applyRailPathDetailedの判定をそのまま使う)。
export function costOfPath(
  mode: ConstructionMode,
  cellCount: number,
  path?: { x: number; z: number }[],
  field?: TerrainField,
  railMap?: Map<string, CellData>
): number {
  switch (mode) {
    case 'rail': {
      if (path && field) {
        const overpassCells = railMap
          ? applyRailPathDetailed({ railMap, stations: new Map() }, path, field).overpassCells
          : new Set<string>();
        // P7b: 勾配追従(flat/incline)/tunnelの内訳はresolveGroundRailPlanに問い合わせる。
        // 建設不可(null)の場合は実際には課金されない(evaluateBuild側がno-effectにする)ため、
        // 見積り表示用に旧来のterrainTypeAt単純合計へフォールバックする。
        const plan = resolveGroundRailPlan(field, path);
        if (plan) {
          return path.reduce((sum, cell, i) => {
            const role = plan[i];
            const overpassMultiplier = overpassCells.has(toKey(cell.x, cell.z)) ? OVERPASS_COST_MULTIPLIER : 1;
            if (role.kind === 'tunnel') return sum + RAIL_COST * TUNNEL_COST_MULTIPLIER * overpassMultiplier;
            const t = field.terrainTypeAt(cell.x, cell.z);
            const terrainMultiplier =
              t === 'water' ? BRIDGE_COST_MULTIPLIER : role.slope === 'incline' ? SLOPE_RAIL_COST_MULTIPLIER : 1;
            return sum + RAIL_COST * terrainMultiplier * overpassMultiplier;
          }, 0);
        }
        return path.reduce((sum, cell) => {
          const t = field.terrainTypeAt(cell.x, cell.z);
          const terrainMultiplier =
            t === 'water' ? BRIDGE_COST_MULTIPLIER : t === 'mountain' ? TUNNEL_COST_MULTIPLIER : 1;
          return sum + RAIL_COST * terrainMultiplier;
        }, 0);
      }
      return cellCount * RAIL_COST;
    }
    case 'bridge': {
      // 坂(両端2セルずつ、計4セル)はRAIL_COST、橋桁(残りの中間セル)は
      // RAIL_COST×OVERPASS_COST_MULTIPLIER。pathが無い場合はcellCountだけでは
      // 坂/橋桁の内訳が分からないため、全セルを橋桁扱い(最も保守的な見積もり)には
      // せず、両端2セルずつを坂とみなして計算する。
      const n = path ? path.length : cellCount;
      if (n <= 0) return 0;
      const pierCount = Math.max(0, n - 4);
      const rampCount = n - pierCount;
      return rampCount * RAIL_COST + pierCount * RAIL_COST * OVERPASS_COST_MULTIPLIER;
    }
    case 'station':
      return STATION_COST;
    case 'depot':
      return DEPOT_COST;
    case 'substation':
      return SUBSTATION_COST;
    case 'signal':
      return SIGNAL_COST;
    default:
      return 0;
  }
}
