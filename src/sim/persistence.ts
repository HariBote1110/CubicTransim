import type { CellData, StationData, TrainData, TrainGroupData, TownData, TerrainType } from '../types';
import type { TrainRuntime } from './simulation';
import { type MonthlyLedger } from './economy';
import type { PassengerCohort } from './passengers';
import { fallbackTownName } from './towns';
import type { SerialisedCornerDiffs, CornerDiffs } from './terrainOverlay';
import { serialiseCornerDiffs, deserialiseCornerDiffs } from './terrainOverlay';

export interface SaveDataV1 {
  version: 1;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
}

export interface SaveDataV2 {
  version: 2;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
}

export interface SaveDataV3 {
  version: 3;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
}

export interface SaveDataV4 {
  version: 4;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
  towns: TownData[];
}

export interface SaveDataV5 {
  version: 5;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
  towns: TownData[];
  terrain: [string, TerrainType][];
}

// v9以前の台帳には利息(interest)が無い。
type LegacyLedger = Omit<MonthlyLedger, 'interest'> & { interest?: number };

export interface SaveDataV6 {
  version: 6;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
  towns: TownData[];
  terrain: [string, TerrainType][];
  clock: { elapsed: number };
  currentLedger: MonthlyLedger;
  ledgerHistory: MonthlyLedger[];
}

export interface SaveDataV7 {
  version: 7;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
  towns: TownData[];
  terrain: [string, TerrainType][];
  clock: { elapsed: number };
  currentLedger: MonthlyLedger;
  ledgerHistory: MonthlyLedger[];
}

export interface SaveDataV8 {
  version: 8;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
  towns: TownData[];
  terrain: [string, TerrainType][];
  clock: { elapsed: number };
  currentLedger: LegacyLedger;
  ledgerHistory: LegacyLedger[];
  stopLocation: 'near' | 'middle' | 'far';
}

export interface SaveDataV9 {
  version: 9;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
  towns: TownData[];
  terrain: [string, TerrainType][];
  clock: { elapsed: number };
  currentLedger: LegacyLedger;
  ledgerHistory: LegacyLedger[];
  stopLocation: 'near' | 'middle' | 'far';
  // 運用グループ(共有運行表と発車間隔)。
  groups: TrainGroupData[];
  // 「グループ×駅」ごとの最終発車時刻(clock.elapsed基準)。発車間隔の判定に使う。
  groupDepartures: [string, number][];
}

export interface SaveDataV10 extends Omit<SaveDataV9, 'version' | 'currentLedger' | 'ledgerHistory'> {
  version: 10;
  currentLedger: MonthlyLedger;
  ledgerHistory: MonthlyLedger[];
  /** 借入残高。 */
  loan: number;
}

export interface SaveDataV11 extends Omit<SaveDataV10, 'version'> {
  version: 11;
  /** 駅ごとの行き先つき待ち客。waitingはこの合計なので、こちらが正。 */
  demand: [string, PassengerCohort[]][];
}

// v11以前にはStationData.cellsのlayer(立体交差の高架ホーム区別)と
// CellData.upperのstationId(高架駅かどうか)が存在しない。型としてはどちらも
// 省略可能なオプショナルフィールドなのでv11の構造をそのまま再利用できるが、
// 「立体交差の十字乗り換え駅」を新設した区切りとしてバージョンを起こす。
export interface SaveDataV12 extends Omit<SaveDataV11, 'version'> {
  version: 12;
}

// v12以前のCellDataは`upper`(1レベル固定の高架)を持つ。v13で多レベル高架
// (`uppers: Partial<Record<1|2|3, ...>>`)に一般化したため、旧形式との区別のために
// バージョンを起こす。ramp.baseも同時に導入(v12以前は常にbase=0=地平からの坂)。
// 旧セーブの実データは型上のCellData(uppers)とは異なる形(upper)を持つため、
// 移行処理側ではLegacyCellDataとして緩く型付けして読む。
export interface LegacyCellData {
  type: CellData['type'];
  connections?: number;
  stationId?: string;
  rotation?: number;
  signalDir?: number;
  bridge?: boolean;
  tunnel?: boolean;
  upper?: { connections: number; stationId?: string };
  ramp?: { dir: number; level?: 1 | 2 };
}

export interface SaveDataV13 extends Omit<SaveDataV12, 'version'> {
  version: 13;
}

// v14: 標高(heights)を一次データとして保存する。v13以前にはheightsが無いため、
// 移行時は旧来の導出(computeElevation: mountainセルの縁からの距離、最大3段)で補う。
export interface SaveDataV14 extends Omit<SaveDataV13, 'version'> {
  version: 14;
  /** セルごとの標高(整数段数)。標高0のセルは含めない(未登録=0)。 */
  heights: [string, number][];
}

// v15: 地形の持ち方を「全セル実体化(terrain/heights Map)」から「決定的な純関数
// (worldSeed)+疎な編集差分(cornerDiffs)」へ転換した(progress/16k-map-architecture.md
// のP3)。旧v14以前のterrain/heights配列は廃止し、worldSeed・halfExtent・cornerDiffsの
// 3つだけを保存する。リリース前でセーブ互換は破壊してよい(ユーザー明言)ため、
// v14以前からの移行処理は書かず、ロード時は問答無用でreject(null)する。
export interface SaveDataV15 extends Omit<SaveDataV14, 'version' | 'terrain' | 'heights'> {
  version: 15;
  /** 地形の乱数シード(sim/terrainField.tsのcreateTerrainFieldへそのまま渡す)。 */
  seed: number;
  /** マップの生成半径(-halfExtent..halfExtentのセルを生成する)。 */
  halfExtent: number;
  /** 盛土/切土の疎な編集差分(sim/terrainOverlay.tsのserialiseCornerDiffs形式)。 */
  cornerDiffs: SerialisedCornerDiffs;
}

export type SaveData =
  | SaveDataV1 | SaveDataV2 | SaveDataV3 | SaveDataV4 | SaveDataV5
  | SaveDataV6 | SaveDataV7 | SaveDataV8 | SaveDataV9 | SaveDataV10 | SaveDataV11
  | SaveDataV12 | SaveDataV13 | SaveDataV14 | SaveDataV15;

// 新規ゲーム開始時の空台帳(1年1月)。v5以前からの移行時にも使う。
export const emptyLedger = (): MonthlyLedger => ({ year: 1, month: 1, fares: 0, construction: 0, upkeep: 0, accidents: 0, interest: 0 });

export function serialiseWorld(
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  trains: TrainData[],
  runtimes: Map<string, TrainRuntime>,
  waiting: Map<string, number>,
  money: number,
  towns: TownData[],
  seed: number,
  clock: { elapsed: number },
  currentLedger: MonthlyLedger,
  ledgerHistory: MonthlyLedger[],
  stopLocation: 'near' | 'middle' | 'far' = 'middle',
  groups: TrainGroupData[] = [],
  groupDepartures: Map<string, number> = new Map(),
  loan = 0,
  demand: Map<string, PassengerCohort[]> = new Map(),
  halfExtent: number,
  cornerDiffs: CornerDiffs = new Map()
): SaveDataV15 {
  return {
    version: 15,
    seed,
    halfExtent,
    cornerDiffs: serialiseCornerDiffs(cornerDiffs),
    railMap: Array.from(railMap.entries()),
    stations: Array.from(stations.entries()),
    trains,
    runtimes: Array.from(runtimes.entries()),
    waiting: Array.from(waiting.entries()),
    money,
    towns,
    clock,
    currentLedger,
    ledgerHistory,
    stopLocation,
    groups,
    groupDepartures: Array.from(groupDepartures.entries()),
    loan,
    demand: Array.from(demand.entries()),
  };
}

export interface RestoredWorld {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  trains: TrainData[];
  runtimes: Map<string, TrainRuntime>;
  waiting: Map<string, number>;
  money: number;
  towns: TownData[];
  /** 地形の乱数シード。sim/terrainField.tsのcreateTerrainFieldへそのまま渡す。 */
  seed: number;
  /** マップの生成半径。 */
  halfExtent: number;
  /** 盛土/切土の疎な編集差分。 */
  cornerDiffs: CornerDiffs;
  clock: { elapsed: number };
  currentLedger: MonthlyLedger;
  ledgerHistory: MonthlyLedger[];
  stopLocation: 'near' | 'middle' | 'far';
  groups: TrainGroupData[];
  groupDepartures: Map<string, number>;
  loan: number;
  demand: Map<string, PassengerCohort[]>;
}

/**
 * セーブデータの復元。v15のみ受け付ける。v14以前はterrain/heights Mapを全セル
 * 実体化していた旧形式であり、v15(worldSeed+halfExtent+cornerDiffs)とは
 * 互換性が無い。リリース前でセーブ互換は破壊してよい(ユーザー明言)ため、
 * 移行処理は書かずnullを返す(呼び出し側は壊れたセーブと同様に扱う)。
 */
export function deserialiseWorld(data: SaveData): RestoredWorld | null {
  if (data.version !== 15) return null;

  // v1データにはpassengers/lastStopStationIdが、v1/v2データにはhaltRemainingが、
  // v7以前のデータにはpathHistory(連結車両の滑らか描画用の走行履歴)が存在しないため、既定値で補う。
  // v15にこれらの旧バージョンは存在しないが、TrainRuntimeの型はセーブ間で共有しているため
  // 同じ既定値補完をそのまま適用しておく(将来型が拡張されたときの安全弁)。
  const runtimes = new Map(
    data.runtimes.map(([id, rt]) => [
      id,
      {
        ...rt,
        passengers: rt.passengers ?? 0,
        lastStopStationId: rt.lastStopStationId ?? null,
        haltRemaining: rt.haltRemaining ?? 0,
        pathHistory: (rt as TrainRuntime).pathHistory ?? [...rt.trail],
        load: (rt as TrainRuntime).load ?? [],
        // 予約(PBS)状態はセーブに含めない。ロード後の最初のstepWorldで
        // ensureRuntime/ensureReservationが再構築する(-1=未取得の状態から再開)。
        reservedEndIndex: -1,
      },
    ])
  );

  const stations = new Map(
    data.stations.map(([id, st]) => [id, {
      ...st,
      platformDoors: st.platformDoors ?? 'none',
      cells: st.cells.map(c => ({ ...c, layer: c.layer ?? 0 })),
    }])
  );

  const towns = data.towns.map((town, i) => (town.name ? town : { ...town, name: fallbackTownName(i) }));
  const trains = data.trains.map(t => ({ ...t, cars: t.cars ?? 2 }));

  return {
    railMap: new Map(data.railMap),
    stations,
    trains,
    runtimes,
    waiting: new Map(data.waiting),
    money: data.money,
    towns,
    seed: data.seed,
    halfExtent: data.halfExtent,
    cornerDiffs: deserialiseCornerDiffs(data.cornerDiffs),
    clock: data.clock,
    currentLedger: data.currentLedger,
    ledgerHistory: data.ledgerHistory,
    stopLocation: data.stopLocation,
    groups: data.groups ?? [],
    groupDepartures: new Map(data.groupDepartures ?? []),
    loan: data.loan,
    demand: new Map(data.demand),
  };
}
