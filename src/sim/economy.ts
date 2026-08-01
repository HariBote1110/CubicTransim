// 経済システムの定数と建設コスト計算。
// 純粋関数のみ。React/THREE には依存しない。
import { toKey } from '../utils';
import type { CellData, PlatformDoorType, TerrainType, TownData } from '../types';
import { terrainAt } from './terrain';
import { applyRailPathDetailed, MAX_BRIDGE_LENGTH } from './construction';
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
export const TRAIN_COST = 5_000; // 新造時(2両編成)の価格
export const CAR_COST = 2_000; // 増結1両あたり
export const CAR_REFUND = 1_000; // 解結1両あたりの払い戻し

// 地形編集(盛土/切土)の1セル・1段あたりのコスト。線路(RAIL_COST=100)の半分にして、
// OpenTTD同様「整地してから敷くほうがトンネル(8倍)・橋(5倍)より安いが、
// 広範囲の造成は財布に響く」バランスにする。
export const TERRAIN_EDIT_COST = 50;

// 地形編集のコスト。cellSteps=変化したセル段数(applyTerrainEditのchangedCells件数。
// 1回の編集で各セルの変化は常に±1段なので件数=総段数)。
export function costOfTerrainEdit(cellSteps: number): number {
  return cellSteps * TERRAIN_EDIT_COST;
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

// 'bridge'は旧・固定長橋の後方互換用(applyBridgeが薄いラッパーとして残っているため)。
// 高架専用ツール('elevated'/'elevated-station')は廃止し、'rail'/'station'がlevel引数
// (buildPreview.ts参照)に従って高架を建設する形に統合した。
export type ConstructionMode = 'rail' | 'station' | 'depot' | 'signal' | 'bridge';

// 自由な高架線(applyElevatedPath)のコスト。坂になるセルはRAIL_COST、橋桁(高架)に
// なるセルはRAIL_COST×OVERPASS_COST_MULTIPLIER。内訳(rampCount/overpassCount)は
// construction.tsのresolveElevatedPathEnd/planElevatedPathが確定させたものを
// 呼び出し側(buildPreview.ts)から渡してもらう(判定ロジックの二重実装を避けるため)。
export function costOfElevatedPath(rampCellCount: number, overpassCellCount: number): number {
  return rampCellCount * RAIL_COST + overpassCellCount * RAIL_COST * OVERPASS_COST_MULTIPLIER;
}

// 高架駅タイル1枚のコスト。立体交差の橋桁を兼ねるぶん通常の駅より割高になる。
export const ELEVATED_STATION_COST = STATION_COST * OVERPASS_COST_MULTIPLIER;

// 地平(level 0)の線路が、浮いた高架の端タイルに自動接続する坂を含む場合のコスト。
// 坂になるセルはRAIL_COST(4倍にはならない。あくまで登り降りの坂であり橋桁ではないため)、
// それ以外の平坦なセルは従来通り地形(水域=橋/山岳=隧道)の倍率つきRAIL_COSTを使う。
// 内訳(どのセルが坂か)はconstruction.tsのplanElevatedPath(level=0)が確定させたものを
// 呼び出し側(buildPreview.ts/useGameLogic.ts)から渡してもらう(判定ロジックの
// 二重実装を避けるため)。
export function costOfGroundPathWithRamps(
  path: { x: number; z: number }[],
  terrain: Map<string, TerrainType>,
  rampFlags: boolean[]
): number {
  return path.reduce((sum, cell, i) => {
    if (rampFlags[i]) return sum + RAIL_COST;
    const t = terrainAt(terrain, cell.x, cell.z);
    const terrainMultiplier = t === 'water' ? BRIDGE_COST_MULTIPLIER : t === 'mountain' ? TUNNEL_COST_MULTIPLIER : 1;
    return sum + RAIL_COST * terrainMultiplier;
  }, 0);
}

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
  terrain?: Map<string, TerrainType>,
  railMap?: Map<string, CellData>
): number {
  switch (mode) {
    case 'rail': {
      if (path && terrain) {
        const overpassCells = railMap
          ? applyRailPathDetailed({ railMap, stations: new Map() }, path, terrain).overpassCells
          : new Set<string>();
        return path.reduce((sum, cell) => {
          const t = terrainAt(terrain, cell.x, cell.z);
          const terrainMultiplier =
            t === 'water' ? BRIDGE_COST_MULTIPLIER : t === 'mountain' ? TUNNEL_COST_MULTIPLIER : 1;
          const overpassMultiplier = overpassCells.has(toKey(cell.x, cell.z)) ? OVERPASS_COST_MULTIPLIER : 1;
          return sum + RAIL_COST * terrainMultiplier * overpassMultiplier;
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
    case 'signal':
      return SIGNAL_COST;
    default:
      return 0;
  }
}
