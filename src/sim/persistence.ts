import type { CellData, StationData, TrainData, TrainGroupData, TownData } from '../types';
import type { TrainRuntime } from './simulation';
import { type MonthlyLedger } from './economy';
import type { PassengerCohort } from './passengers';
import { fallbackTownName } from './towns';
import type { SerialisedCornerDiffs, CornerDiffs } from './terrainOverlay';
import { serialiseCornerDiffs, deserialiseCornerDiffs } from './terrainOverlay';
import type { TownDensity } from './towns';
import type { TerrainProfile } from './terrainField';
import type { GameRules } from './gameRules';
import { DEFAULT_GAME_RULES } from './gameRules';

// v15: 地形の持ち方を「全セル実体化(terrain/heights Map)」から「決定的な純関数
// (worldSeed)+疎な編集差分(cornerDiffs)」へ転換した(progress/16k-map-architecture.md
// のP3)。旧v14以前のterrain/heights配列は廃止し、worldSeed・halfExtent・cornerDiffsの
// 3つだけを保存する。リリース前でセーブ互換は破壊してよい(ユーザー明言)ため、
// v14以前からの移行処理は書かず、ロード時は問答無用でreject(null)する
// (P6でV1〜V14の型チェーンとLegacyCellData/LegacyLedgerを削除し、SaveDataV15単独の
// 定義にした。旧バージョン識別に必要な`version`フィールドだけをLegacySaveDataに残す)。
// v16: 新規ゲームの「地形」選択(平坦/標準/山がち)を terrainProfile として保存する
// (progress/terrain-profiles.md)。v15セーブは terrainProfile が無いだけで、地形は
// 標準テーブルで生成されていたことが確定しているため、'normal' として読み込む
// (v14以前と違い破壊的な形式変更ではないので、拒否せず受け入れる)。
// v17: プレイモード(ライト/ノーマル/アドバンスド/リアリスティック)のルールフラグ集合を
// rules として保存する(progress/play-modes-plan.md PM1)。モード名ではなくフラグ集合を
// 保存するのは、後からモード定義(既定値セット)を変えても既存セーブが壊れないようにするため。
// v16以前のセーブにrulesは無いが、その時点では概念自体が存在しなかったことが確定しているため、
// DEFAULT_GAME_RULES(ライト相当)として読み込む。PM1では読み込む以外に誰もrulesを参照しないため、
// 挙動は一切変わらない。
export interface SaveDataV17 {
  version: 17 | 16 | 15;
  /** 地形の乱数シード(sim/terrainField.tsのcreateTerrainFieldへそのまま渡す)。 */
  seed: number;
  /** マップの生成半径(-halfExtent..halfExtentのセルを生成する)。 */
  halfExtent: number;
  /** 盛土/切土の疎な編集差分(sim/terrainOverlay.tsのserialiseCornerDiffs形式)。 */
  cornerDiffs: SerialisedCornerDiffs;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
  towns: TownData[];
  clock: { elapsed: number };
  currentLedger: MonthlyLedger;
  ledgerHistory: MonthlyLedger[];
  stopLocation: 'near' | 'middle' | 'far';
  /** 運用グループ(共有運行表と発車間隔)。 */
  groups: TrainGroupData[];
  /** 「グループ×駅」ごとの最終発車時刻(clock.elapsed基準)。発車間隔の判定に使う。 */
  groupDepartures: [string, number][];
  /** 借入残高。 */
  loan: number;
  /** 駅ごとの行き先つき待ち客。waitingはこの合計なので、こちらが正。 */
  demand: [string, PassengerCohort[]][];
  /**
   * 新規ゲーム開始時に選んだ町密度(sim/towns.tsのTownDensity)。additive optional:
   * このセッションより前のv15セーブには存在しないため、読み込み時はnormalを既定にする
   * (townsそのものはセーブに実体を持つため、この値からtownsを再生成することはない。
   * UI表示や将来の追加生成の参考情報としてのみ保持する)。
   */
  townDensity?: TownDensity;
  /**
   * 地形プロファイル(平坦/標準/山がち)。v15セーブには存在しないため、
   * 読み込み時は 'normal'(歴史的既定)を補う。seedと組で地形を決めるので、
   * townDensityと違いロード後の地形生成に実際に使われる。
   */
  terrainProfile?: TerrainProfile;
  /**
   * プレイモードのルールフラグ集合(gauge/electrification/signalling)。v16以前のセーブには
   * 存在しないため、読み込み時はDEFAULT_GAME_RULES(ライト相当)を補う。PM1時点では
   * 保存・復元のみでゲームロジックからは未参照。
   */
  rules?: GameRules;
}

/** v14以前の旧セーブ。バージョン判定にのみ使う(内容は読まない。deserialiseWorldが即reject)。 */
export interface LegacySaveData {
  version: number;
}

export type SaveData = SaveDataV17 | LegacySaveData;

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
  cornerDiffs: CornerDiffs = new Map(),
  townDensity: TownDensity = 'normal',
  terrainProfile: TerrainProfile = 'normal',
  rules: GameRules = DEFAULT_GAME_RULES
): SaveDataV17 {
  return {
    version: 17,
    seed,
    halfExtent,
    cornerDiffs: serialiseCornerDiffs(cornerDiffs),
    townDensity,
    terrainProfile,
    rules,
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
  /** 町密度(省略時=normal)。 */
  townDensity: TownDensity;
  /** 地形プロファイル(省略時=normal)。createTerrainFieldへそのまま渡す。 */
  terrainProfile: TerrainProfile;
  /** プレイモードのルールフラグ集合(省略時=DEFAULT_GAME_RULES=ライト相当)。 */
  rules: GameRules;
}

/**
 * セーブデータの復元。v17と(rules欠落=ライト相当扱いの)v16・(terrainProfile欠落=normal扱いの)v15を受け付ける。
 * v14以前はterrain/heights Mapを全セル実体化していた旧形式であり、v15(worldSeed+halfExtent+cornerDiffs)とは
 * 互換性が無い。リリース前でセーブ互換は破壊してよい(ユーザー明言)ため、
 * 移行処理は書かずnullを返す(呼び出し側は壊れたセーブと同様に扱う)。
 */
export function deserialiseWorld(input: SaveData): RestoredWorld | null {
  if (input.version !== 17 && input.version !== 16 && input.version !== 15) return null;
  // LegacySaveDataのversionは(旧バージョン識別のためだけに)number型なので、上のガードだけでは
  // TypeScriptの判別共用体narrowingが効かない(number側が15/16/17を許容範囲として残るため)。
  // ここまで来た時点でversionが15/16/17であることは実行時に確定しているので、明示的に絞り込む。
  const data = input as SaveDataV17;

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
    townDensity: data.townDensity ?? 'normal',
    terrainProfile: data.terrainProfile ?? 'normal',
    rules: data.rules ?? DEFAULT_GAME_RULES,
  };
}
