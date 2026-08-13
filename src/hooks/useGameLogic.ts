import { useState, useRef, useEffect, useMemo } from 'react';
import { toKey } from '../utils';
import type { CellData, CellType, TrainData, LineData, ServiceData, StationData, PlatformDoorType, TownData, TrainPower, RailGauge, TrainProtection } from '../types';
import { DEFAULT_GAUGE } from '../types';
import type { SimWorld, SimEvent } from '../sim/simulation';
import { occupiedCellKeysFromRuntimes } from '../sim/simulation';
import { serialiseWorld, deserialiseWorld, emptyLedger } from '../sim/persistence';
import type { SaveData } from '../sim/persistence';
import {
  applyRailPathDetailed, applyStationPath, applyDepot, applySubstation, applySignal, applyElevatedPath, applyElevatedStation,
  applyUndergroundPath, applyUndergroundStation, applyRegaugePath,
  removePath, resolveElevatedPathEnd, pickElevatedConnection, planElevatedPath, isElevatedConnectPlanBuildable,
  resolveGroundRailPlanWithAutoFill,
} from '../sim/construction';
import type { ConstructionState, StationAxis, BuildLevel, ElevatedLevel, UndergroundLevel, RailBuildOptions } from '../sim/construction';
import {
  STARTING_MONEY, costOfPath, costOfElevatedPath, costOfGroundPathWithRamps, ELEVATED_STATION_COST,
  costOfUndergroundPath, UNDERGROUND_STATION_COST,
  PLATFORM_DOOR_STANDARD_COST, PLATFORM_DOOR_FULLSCREEN_COST,
  calculateUpkeep, CAR_COST, CAR_REFUND, costOfTerrainEdit, costOfElectrification, costOfRegauge,
  trainCostForProtected, costOfProtection, costMultiplierForRailWeight, trainSellRefund,
} from '../sim/economy';
import type { TerrainField } from '../sim/terrainField';
import { createTerrainField, fieldFromMaps, DEFAULT_HALF_EXTENT, DEFAULT_TERRAIN_PROFILE } from '../sim/terrainField';
import type { TerrainProfile } from '../sim/terrainField';
import { DEFAULT_GAME_RULES } from '../sim/gameRules';
import type { GameRules } from '../sim/gameRules';
import { AXLE_LOAD_T_BY_POWER } from '../sim/physics';
import { buildFeedingIndex } from '../sim/feeding';
import { buildBlockIndex } from '../sim/blocks';
import type { CornerDiffs, TerrainEditMode } from '../sim/terrainOverlay';
import { createEditedTerrainField, applyCornerEdit, buildEditBlockers, cornerDiffsFromField } from '../sim/terrainOverlay';

// 編成の最小・最大両数
const MIN_CARS = 1;
const MAX_CARS = 8;
import type { MonthlyLedger } from '../sim/economy';
import { LOAN_STEP, monthlyInterest, repayLoan, takeLoan } from '../sim/loans';
import { generateRegionTowns } from '../sim/towns';
import type { TownDensity } from '../sim/towns';
import { TownTileCache } from '../sim/townTiles';
import {
  effectiveSchedule, resolveAssignment, findLine, findService, serviceStops,
  nextLineName, nextLineColour, nextStop, createLineWithDefaultService,
} from '../sim/lines';
import type { LineMode } from '../sim/lines';
import { relocateTrain } from '../sim/relocate';
import { createDebugScenario } from '../sim/debugScenario';
import type { DebugScenarioWorld } from '../sim/debugScenarios';

const SAVE_KEY = 'cubictransim-save-v1';

// 台帳履歴として保持する直近ヶ月数。
const LEDGER_HISTORY_LIMIT = 12;

// 事故バナー表示用の通知の生存確認間隔(ms)。該当列車のhaltRemainingが0になったら消す。
const ACCIDENT_POLL_INTERVAL_MS = 500;

export interface AccidentNotice {
  trainId: string;
  stationId: string;
  /** S3の信号冒進(SPAD)通知か。省略時は従来どおりの駅の人身事故。 */
  kind?: 'spad';
}

export const useGameLogic = () => {
  const [railMap, setRailMap] = useState<Map<string, CellData>>(new Map());
  const [stations, setStations] = useState<Map<string, StationData>>(new Map());
  const [trains, setTrains] = useState<TrainData[]>([]);

  // ★追加(P3): 地形の乱数シード。terrainField.tsのcreateTerrainFieldへそのまま渡す
  // 決定的な純関数のパラメータで、全セルを実体化しない(progress/16k-map-architecture.md)。
  const [worldSeed, setWorldSeed] = useState<number>(() => Date.now() % 2 ** 31);
  // マップの生成半径(-halfExtent..halfExtentのセルを生成する)。既定はDEFAULT_HALF_EXTENT
  // (45、小91×91)。新規ゲーム時(newGame)にマップサイズ選択UIから差し替えられる。
  const [halfExtent, setHalfExtent] = useState<number>(DEFAULT_HALF_EXTENT);
  // 地形プロファイル(平坦/標準/山がち)。世界ごとに不変で、newGame/loadGameでのみ変わる。
  // seedと同じくWebGPUレンダラー側にも渡して同じ地形を生成させる。
  const [terrainProfile, setTerrainProfile] = useState<TerrainProfile>(DEFAULT_TERRAIN_PROFILE);
  const [gameRules, setGameRules] = useState<GameRules>(DEFAULT_GAME_RULES);
  // 盛土/切土の疎な編集差分(コーナー格子)。terrainOverlay.tsのCornerDiffs。
  const [cornerDiffs, setCornerDiffs] = useState<CornerDiffs>(new Map());
  // デバッグシナリオが手組みの地形(尾根など、乱数シードでは表現できない形)を使うときの
  // 上書きfield。通常プレイ中はnull(=worldSeed+halfExtent+cornerDiffsから合成したfieldを使う)。
  const [debugFieldOverride, setDebugFieldOverride] = useState<TerrainField | null>(null);

  // worldSeed・halfExtentから決定的に導出する基底field。編集差分を含まない。
  const baseField = useMemo(
    () => createTerrainField(worldSeed, halfExtent, terrainProfile),
    [worldSeed, halfExtent, terrainProfile]
  );
  // 基底fieldへcornerDiffsを合成したfield。盛土/切土の結果を反映する。
  const editedField = useMemo(() => createEditedTerrainField(baseField, cornerDiffs), [baseField, cornerDiffs]);
  // 実際にゲーム全体が参照するfield。デバッグシナリオの上書きがあればそちらを優先する。
  const field: TerrainField = debugFieldOverride ?? editedField;

  // ★追加: 街(town)。初回起動(セーブなしの新規状態)では領域ベースの決定的配置
  // (generateRegionTowns、P5)で自動生成する。ロード時はセーブデータのtownsで置き換わる。
  // 街は必ず平地に生成されるよう、baseFieldを渡して水域・山岳付近を除外する。
  // 新規ゲーム開始時に選んだ町密度(App.tsxの起動ダイアログから指定、既定normal)。
  // セーブへも保持するが(persistence.tsのtownDensity)、ロード時にtownsを
  // 再生成する用途には使わない(towns自体がセーブに実体を持つため)。
  const [townDensity, setTownDensity] = useState<TownDensity>('normal');
  const [towns, setTowns] = useState<TownData[]>(() =>
    generateRegionTowns(worldSeed + 1, halfExtent, baseField, townDensity)
  );
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>(null);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);
  // ★追加: 車庫選択(列車選択・駅選択とは排他)。toKey(x,z)形式のセルキー。
  const [selectedDepotKey, setSelectedDepotKey] = useState<string | null>(null);
  const [isEditingSchedule, setIsEditingSchedule] = useState(false);

  // ★追加: 人身事故の通知(バナー表示用)。列車のhaltRemainingが尽きたら自動的に消える。
  const [activeAccidents, setActiveAccidents] = useState<AccidentNotice[]>([]);

  // ★追加: スケジュール用クリップボード
  const [scheduleClipboard, setScheduleClipboard] = useState<string[] | null>(null);

  // ★追加: 所持金。建設・列車購入のたびに減算し、運賃収入で増加する。マイナスも許容する(赤字表示のみ)。
  const [money, setMoney] = useState<number>(STARTING_MONEY);

  // ★追加: 借入残高。序盤に建設しすぎて列車を買えず詰むのを防ぐための資金繰り手段。
  // 月末に残高に応じた利息を支払う(sim/loans.ts)。
  const [loan, setLoan] = useState<number>(0);

  // ★追加: 駅停車位置設定(OpenTTD流のNear/Middle/Far)。ゲーム全体設定。既定値'middle'。
  const [stopLocation, setStopLocation] = useState<'near' | 'middle' | 'far'>('middle');

  // ★追加: 路線＋種別(共有運行表＋発車間隔)。所属列車は種別の有効運行表に従う。
  const [lines, setLines] = useState<LineData[]>([]);
  const [services, setServices] = useState<ServiceData[]>([]);

  // ★追加: 月次収支台帳。今月の途中経過(currentLedger)と、確定済み直近12ヶ月(ledgerHistory)。
  const [currentLedger, setCurrentLedger] = useState<MonthlyLedger>(emptyLedger());
  const [ledgerHistory, setLedgerHistory] = useState<MonthlyLedger[]>([]);

  // シミュレーション世界の実体。runtimes/waitingは列車ID/駅IDごとに保持し続け、
  // railMap/stations/trainsはReact stateが更新されるたびに差し替える。
  const worldRef = useRef<SimWorld>({
    railMap: new Map(),
    stations: new Map(),
    trains: [],
    runtimes: new Map(),
    waiting: new Map(),
    rng: Math.random,
    economyMirror: { money: STARTING_MONEY },
    towns,
    terrainField: field,
    clock: { elapsed: 0 },
    stopLocation: 'middle',
    lines: [],
    services: [],
    serviceDepartures: new Map(),
  });

  useEffect(() => {
    worldRef.current.railMap = railMap;
  }, [railMap]);

  useEffect(() => {
    worldRef.current.stations = stations;
  }, [stations]);

  useEffect(() => {
    worldRef.current.trains = trains;
  }, [trains]);

  useEffect(() => {
    worldRef.current.towns = towns;
  }, [towns]);

  useEffect(() => {
    worldRef.current.terrainField = field;
  }, [field]);

  // economyMirrorはデバッグ/表示用のReact state鏡写しで、simロジックからは参照されない。
  useEffect(() => {
    worldRef.current.economyMirror = { money };
  }, [money]);

  useEffect(() => {
    worldRef.current.stopLocation = stopLocation;
  }, [stopLocation]);

  useEffect(() => {
    worldRef.current.lines = lines;
  }, [lines]);

  useEffect(() => {
    worldRef.current.services = services;
  }, [services]);

  // PM2: プレイモードのルールフラグ集合をSimWorldへ鏡写しする(stepWorldの経路探索が
  // rules.gauge/electrificationを参照するため)。newGame/loadGameでも即座に上書きするが、
  // このeffectが無いと初期マウント時の既定値(DEFAULT_GAME_RULES)のまま更新が遅れる
  // (railMap等と同じ同期パターン)。
  useEffect(() => {
    worldRef.current.rules = gameRules;
  }, [gameRules]);

  // ★追加: 事故バナーの自動消去。該当列車のhaltRemainingが尽きたら通知を取り除く。
  useEffect(() => {
    const id = setInterval(() => {
      setActiveAccidents(prev =>
        prev.filter(a => {
          const rt = worldRef.current.runtimes.get(a.trainId);
          return rt ? rt.haltRemaining > 0 : false;
        })
      );
    }, ACCIDENT_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // ★追加(P5): 町タイル索引(セルキー→ 町id/'house'|'road')。TownTileCacheは町ごとに
  // 遅延生成・キャッシュする(sim/townTiles.ts参照)。生成コストはクエリされた町の分だけで、
  // マップが16K級で町が数千個になっても「railMapが変わるたびに全町再生成」にはならない。
  // インスタンス自体の構築(空間バケットの割り当て)はO(towns)だが軽い(生成は含まない)。
  const townTileIndex = useMemo(
    () => new TownTileCache(towns, field, railMap),
    [towns, field, railMap]
  );

  // PM4: き電インフラの索引。townTileIndexと同じ規律で、railMapが変わったときだけ
  // 再計算する(変電所はrailMapのセルとして持つため、substations一覧もrailMapから
  // 都度導出する)。rules.electrification!=='feeding'のときも常に計算はするが、
  // stepWorld側がrules.electrificationを見て参照するかどうかを決めるため無害
  // (低いプレイモードでは誰も参照しない=挙動変更ゼロ)。
  const feedingIndex = useMemo(() => {
    const substations: { x: number; z: number }[] = [];
    for (const [key, cell] of railMap) {
      if (cell.type === 'substation') {
        const [x, z] = key.split(',').map(Number);
        substations.push({ x, z });
      }
    }
    return buildFeedingIndex(railMap, substations);
  }, [railMap]);

  useEffect(() => {
    worldRef.current.feeding = feedingIndex;
  }, [feedingIndex]);

  // S1: 固定閉塞のブロック索引。feedingIndexと同じ同期パターンで、railMapが
  // 変わったときだけ再計算する。rules.signalling!=='s1'のときも常に計算はするが、
  // stepWorld側が参照しないため無害(挙動変更ゼロ)。
  const blockIndex = useMemo(() => buildBlockIndex(railMap), [railMap]);

  useEffect(() => {
    worldRef.current.blocks = blockIndex;
  }, [blockIndex]);

  // --- Commit Path ---
  // railMap/stations の更新ロジックは sim/construction.ts の純粋関数に委譲する。
  // ここでは現在の state を渡し、結果をまとめて setRailMap/setStations するだけの薄いラッパー。
  // 建設コストの算出・所持金チェック・課金もここで行う。
  const commitPath = (
    path: { x: number; z: number }[],
    buildMode: CellType | 'none' | 'remove' | 'signal' | TerrainEditMode | 'regauge',
    // 駅設置(station)専用: ドラッグした向きから決まる軸のヒント。
    // 省略時はapplyStationが隣接セルから軸を推測する(なければ東西が既定)。
    stationAxisHint?: StationAxis,
    // 線路(rail)・駅(station)専用: 建設対象レベル(0=地平〜3)。省略時は0。
    level: BuildLevel = 0,
    // PM2: 線路(rail)専用の軌間/電化選択。rules.gauge=falseのUIからは常に省略される
    // ため、既存の建設挙動は変わらない。
    railOptions: RailBuildOptions = {},
    // PM2 Stage B: 改軌(buildMode==='regauge')専用の目的軌間。
    regaugeTargetGauge?: RailGauge,
    // S2: 信号(buildMode==='signal')専用の種別選択。rules.signalling!=='s2'のUIからは
    // 常に'block'のまま渡ってくるため、applySignal側で新規設置時に'block'相当(undefined)
    // へ丸め込む必要はなく、そのまま渡してよい(s2以外はblocksSegmentEntryが種別を見ない)。
    signalKind?: CellData['signalKind']
  ) => {
    if (path.length === 0) return;

    // 地形編集(盛土/切土)。railMap/stationsではなくcornerDiffsを更新する別系統なので
    // ここで完結させる。可否・伝播はsim/terrainOverlay.tsのapplyCornerEditが判定し、
    // 変化が無ければ同一参照が返る(=課金しない)。コストは伝播分を含む変化コーナー数に比例。
    // デバッグシナリオの手組みfield(debugFieldOverride)を使っている間は編集経路が
    // 無いため何もしない(デバッグ専用の割り切り)。
    if (buildMode === 'raise' || buildMode === 'lower') {
      if (debugFieldOverride) return;
      const blockers = buildEditBlockers({ halfExtent, railMap, townTileIndex, baseField });
      const a = path[0];
      const b = path[path.length - 1];
      const result = applyCornerEdit(baseField, editedField, { a, b }, buildMode, blockers);
      if (result.field === editedField) return;
      const cost = costOfTerrainEdit(result.changedCorners);
      if (money < cost) return;
      setCornerDiffs(result.field.diffs);
      setMoney(m => m - cost);
      setCurrentLedger(l => ({ ...l, construction: l.construction + cost }));
      return;
    }

    const state: ConstructionState = { railMap, stations };
    let result: ConstructionState;
    let cost = 0;

    switch (buildMode) {
      case 'remove':
        // 撤去は無料・払い戻しなし
        result = removePath(state, path);
        break;
      case 'signal':
        cost = costOfPath('signal', path.length);
        if (money < cost) return;
        result = applySignal(state, path, field, townTileIndex, signalKind);
        break;
      case 'station': {
        if (level === 0) {
          cost = costOfPath('station', path.length);
          if (money < cost) return;
          // OpenTTD式のドラッグ駅建設: 経路全体(単発クリックならpath.length===1)を
          // まとめて1つの駅として建設する。
          // 駅設置時点では町を湧かせない(近くに町が無くてもそのまま建てられる)。
          // 命名は既存の町名由来/A駅フォールバックのまま(applyStationのstationNameFor)。
          // 町は輸送力が育ってから日次チェック(resolveTownSpawnTick)で湧く。
          result = applyStationPath(state, path, field, towns, stationAxisHint, townTileIndex);
        } else if (level > 0) {
          // 高架駅タイル1枚(旧'elevated-station')。
          cost = ELEVATED_STATION_COST;
          if (money < cost) return;
          const stationPos = path[path.length - 1];
          result = applyElevatedStation(state, stationPos, towns, level as ElevatedLevel);
        } else {
          // P8a/P8c: 地下駅タイル1枚。高架駅と対称(applyElevatedStation/applyLayeredStationの
          // 薄いラッパー)。町タイル・水域下の制約はapplyUndergroundStation側で判定済み。
          cost = UNDERGROUND_STATION_COST;
          if (money < cost) return;
          const stationPos = path[path.length - 1];
          result = applyUndergroundStation(state, stationPos, towns, level as UndergroundLevel);
        }
        break;
      }
      case 'depot':
        cost = costOfPath('depot', path.length);
        if (money < cost) return;
        result = applyDepot(state, path[path.length - 1], field, townTileIndex);
        break;
      case 'substation':
        cost = costOfPath('substation', path.length);
        if (money < cost) return;
        result = applySubstation(state, path[path.length - 1], field, townTileIndex);
        break;
      case 'rail': {
        if (level === 0) {
          // 端が浮いた高架の端タイルに接する場合、applyRailPath(applyRailPathDetailed)が
          // 自動で坂を作って接続する。その場合のコストもconstruction.ts側の判定
          // (resolveElevatedPathEnd/pickElevatedConnection/planElevatedPath/
          // isElevatedConnectPlanBuildable)にそのまま問い合わせる
          // (buildPreview.tsと同じロジックの二重実装を避けるため)。
          let groundRampFlags: boolean[] | null = null;
          if (path.length >= 2) {
            const startEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, path[0]), 0);
            const endEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, path[path.length - 1]), 0);
            if (startEnd.kind === 'connect' || endEnd.kind === 'connect') {
              const plan = planElevatedPath(path.length, startEnd, endEnd, 0);
              if (plan && isElevatedConnectPlanBuildable(railMap, path, field, plan)) {
                groundRampFlags = plan.roles.map(r => r.kind === 'ramp');
              }
            }
          }
          // 水域(橋)・山岳(トンネル)を通る区間はコストが割増になる
          cost = (groundRampFlags
            ? costOfGroundPathWithRamps(path, field, groundRampFlags)
            : costOfPath('rail', path.length, path, field)) * costMultiplierForRailWeight(railOptions.railWeight);
          if (railOptions.electrified) cost += costOfElectrification(path.length);
          if (railOptions.protection) cost += costOfProtection(path.length, railOptions.protection);
          // P-terraform: other-slopeで詰まった区間の自動整地(埋め立て)が必要かを
          // resolveGroundRailPlanWithAutoFillへ事前に問い合わせ、コストへ上乗せする
          // (buildPreview.tsと同じ判定を、実際の課金前にも一度使う)。デバッグ手組みの
          // field(debugFieldOverride)を使っている間は編集経路が無いため試みない
          // (raise/lowerの既存の割り切りと同じ)。
          const terrainFillOptions = !debugFieldOverride
            ? { base: baseField, blockers: buildEditBlockers({ halfExtent, railMap, townTileIndex, baseField }) }
            : undefined;
          if (terrainFillOptions) {
            const autoFilled = resolveGroundRailPlanWithAutoFill(terrainFillOptions.base, editedField, path, terrainFillOptions.blockers);
            if (autoFilled.terraformCorners > 0) cost += costOfTerrainEdit(autoFilled.terraformCorners);
          }
          if (money < cost) return;
          const detailed = applyRailPathDetailed(state, path, field, townTileIndex, railOptions, terrainFillOptions);
          result = detailed;
          // P-terraform: 実際に整地が起きていれば、手動raise/lowerと同じcornerDiffsの
          // 経路(setCornerDiffs)で永続化する(セーブ/読込・描画チャンクの再構築を含めて
          // 既存の地形編集と完全に同じ扱いになる)。
          if (detailed.terrainEdit) setCornerDiffs(detailed.terrainEdit.diffs);
        } else if (level > 0) {
          // 自由な高架線(旧'elevated')。坂・橋桁の内訳はconstruction.ts側の判定
          // (resolveElevatedPathEnd/pickElevatedConnection/planElevatedPath)にそのまま
          // 問い合わせる(buildPreview.tsと同じロジックの二重実装を避けるため)。
          const elevatedLevel = level as ElevatedLevel;
          const startEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, path[0]), elevatedLevel);
          const endEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, path[path.length - 1]), elevatedLevel);
          const plan = planElevatedPath(path.length, startEnd, endEnd, elevatedLevel);
          const rampCount = plan ? plan.roles.filter(r => r.kind === 'ramp').length : 0;
          const overpassCount = plan ? plan.roles.filter(r => r.kind === 'span').length : 0;
          cost = costOfElevatedPath(rampCount, overpassCount) * costMultiplierForRailWeight(railOptions.railWeight);
          if (railOptions.electrified) cost += costOfElectrification(path.length);
          if (railOptions.protection) cost += costOfProtection(path.length, railOptions.protection);
          if (money < cost) return;
          result = applyElevatedPath(state, path, field, elevatedLevel, undefined, townTileIndex, railOptions);
        } else {
          // P8a/P8c: 自由な地下線。design docの通り、坂(掘割)/地下線本体を区別せず
          // 経路の全セルへ一律のコスト倍率(UNDERGROUND_RAIL_COST_MULTIPLIER)を課す
          // (buildPreview.tsのcostOfUndergroundPathと同じ計算)。
          const undergroundLevel = level as UndergroundLevel;
          cost = costOfUndergroundPath(path.length) * costMultiplierForRailWeight(railOptions.railWeight);
          if (railOptions.electrified) cost += costOfElectrification(path.length);
          if (railOptions.protection) cost += costOfProtection(path.length, railOptions.protection);
          if (money < cost) return;
          result = applyUndergroundPath(state, path, field, undergroundLevel, undefined, railOptions);
        }
        break;
      }
      case 'regauge': {
        // PM2 Stage B: 改軌。目的軌間が無ければ何もしない。列車が在線中のセルを含む
        // 経路は全体がno-op(construction.tsのapplyRegaugePathが判定)。課金対象は
        // 実際に軌間が変わったセル数のみ(buildPreview.tsと同じ規約)。
        if (!regaugeTargetGauge) return;
        // H4: TrainData.x/zは車庫での初期位置のまま更新されないため、走行中の実位置
        // (worldRef.current.runtimes)から在線セルを求める(sim/simulation.tsの
        // occupiedCellKeysFromRuntimes)。
        const occupiedCells = occupiedCellKeysFromRuntimes(worldRef.current.runtimes);
        const regauged = applyRegaugePath(state, path, regaugeTargetGauge, occupiedCells);
        if (regauged.railMap === state.railMap) return;
        const changedCellCount = path.filter(p => {
          const key = toKey(p.x, p.z);
          return railMap.get(key)?.gauge !== regauged.railMap.get(key)?.gauge;
        }).length;
        cost = costOfRegauge(changedCellCount);
        if (money < cost) return;
        result = regauged;
        break;
      }
      default:
        return;
    }

    // no-op(上書き防止などで変化が無かった)場合は課金しない。
    // construction.ts の apply 系は変化が無ければ同一参照を返す実装になっている。
    const changed = result.railMap !== state.railMap || result.stations !== state.stations;
    if (changed && cost > 0) {
      setMoney(m => m - cost);
      setCurrentLedger(l => ({ ...l, construction: l.construction + cost }));
    }

    setRailMap(result.railMap);
    setStations(result.stations);
  };

  const removeSignal = (x: number, z: number) => {
     setRailMap(prev => {
       const newMap = new Map(prev);
       const key = toKey(x, z);
       const cell = newMap.get(key);
       if (cell) {
         newMap.set(key, { ...cell, signalDir: undefined });
       }
       return newMap;
     });
  };

  const handleTrainArrive = (trainId: string, currentIndex: number) => {
    setTrains(prev => prev.map(t => {
      if (t.id !== trainId) return t;
      // 種別所属中は路線の有効運行表を使う。路線の運行モード(環状/折返し)に従って次の駅へ。
      const lns = worldRef.current.lines ?? [];
      const svcs = worldRef.current.services ?? [];
      const schedule = effectiveSchedule(t, lns, svcs);
      if (schedule.length === 0) return t;
      const assignment = resolveAssignment(t, lns, svcs);
      const next = nextStop(
        { index: currentIndex, direction: t.scheduleDirection ?? 1 },
        schedule.length,
        assignment?.line.mode ?? 'loop'
      );
      return { ...t, scheduleIndex: next.index, scheduleDirection: next.direction };
    }));
  };

  // PM2: powerは購入UIから選ぶ(省略時=気動車)。軌間は車庫セルの軌間を自動で継承する
  // (rules.gaugeが有効な場合のみ。無効時はgauge概念が無いためundefinedのまま=旧来どおり)。
  const buyTrain = (x: number, z: number, power: TrainPower = 'diesel', protection?: TrainProtection) => {
    // PM3: 交流/交直流車は価格が異なる(economy.tsのtrainCostFor)。
    // rules.electrification==='none'ならpower自体を持たせないので常にdiesel価格になる。
    // S3: 保安装置の車上装置分の倍率(trainCostForProtected)をさらに乗算合成する。
    // rules.signalling!=='s3'ならprotection自体を渡さないUIになるので常に基準額のまま。
    const cost = trainCostForProtected(gameRules.electrification !== 'none' ? power : 'diesel', protection);
    if (money < cost) return;
    const depotCell = worldRef.current.railMap.get(toKey(x, z));
    const newTrain: TrainData = {
        id: Math.random().toString(36).substr(0, 4),
        x, z,
        schedule: [], scheduleIndex: 0, status: 'stored',
        cars: 2,
        ...(gameRules.gauge ? { gauge: depotCell?.gauge ?? DEFAULT_GAUGE } : {}),
        ...(gameRules.electrification !== 'none' ? { power } : {}),
        ...(gameRules.signalling === 's3' && protection ? { protection } : {}),
        // 軌道(何キロレール): 動力方式から軸重を導出する(physics.tsのAXLE_LOAD_T_BY_POWER)。
        // trackClasses=falseなら概念が無いため付与しない(従来どおりの挙動)。
        ...(gameRules.trackClasses
          ? { axleLoadT: AXLE_LOAD_T_BY_POWER[gameRules.electrification !== 'none' ? power : 'diesel'] }
          : {}),
    };
    setTrains(prev => [...prev, newTrain]);
    setMoney(m => m - cost);
    setCurrentLedger(l => ({ ...l, construction: l.construction + cost }));
  };

  // ★追加: 車庫在籍中の列車を売却する。払い戻し(sim/economy.tsのtrainSellRefund)は
  // CAR_REFUND/CAR_COSTと同じ50%比率を編成全体に適用したもの。運行中の列車は対象外。
  const sellTrain = (trainId: string) => {
    const target = trains.find(t => t.id === trainId);
    if (!target || target.status !== 'stored') return;
    const power = gameRules.electrification !== 'none' ? (target.power ?? 'diesel') : 'diesel';
    const baseCost = trainCostForProtected(power, target.protection);
    const refund = trainSellRefund(baseCost, target.cars);
    setTrains(prev => prev.filter(t => t.id !== trainId));
    setMoney(m => m + refund);
    setCurrentLedger(l => ({ ...l, construction: l.construction - refund }));
    if (selectedTrainId === trainId) setSelectedTrainId(null);
  };

  // ★追加: 車庫選択(列車選択・駅選択とは排他)。GameScene側から車庫セルクリックで呼ばれる。
  const selectDepot = (x: number, z: number) => {
    setSelectedDepotKey(toKey(x, z));
    setSelectedTrainId(null);
    setSelectedStationId(null);
    setIsEditingSchedule(false);
  };

  // ★追加: 増結(車庫在籍中の列車のみ想定。running中はGameUI側でボタンを非表示にする)。
  // 8両超は不可、資金不足時は不可。増結費用は月次台帳のconstructionに計上する。
  const addCar = (trainId: string) => {
    const target = trains.find(t => t.id === trainId);
    if (!target) return;
    if (target.cars >= MAX_CARS) return;
    if (money < CAR_COST) return;
    setTrains(prev => prev.map(t => (t.id === trainId ? { ...t, cars: t.cars + 1 } : t)));
    setMoney(m => m - CAR_COST);
    setCurrentLedger(l => ({ ...l, construction: l.construction + CAR_COST }));
  };

  // ★追加: 解結。1両未満にはできない。払い戻しも月次台帳のconstructionに(マイナス計上で)計上する。
  const removeCar = (trainId: string) => {
    const target = trains.find(t => t.id === trainId);
    if (!target) return;
    if (target.cars <= MIN_CARS) return;
    setTrains(prev => prev.map(t => (t.id === trainId ? { ...t, cars: t.cars - 1 } : t)));
    setMoney(m => m + CAR_REFUND);
    setCurrentLedger(l => ({ ...l, construction: l.construction - CAR_REFUND }));
  };

  // ★追加: 運賃収入の反映(sim層の'income'イベントを受けて呼ばれる)
  const addIncome = (amount: number) => {
    setMoney(m => m + amount);
    setCurrentLedger(l => ({ ...l, fares: l.fares + amount }));
  };

  // ★追加: 月次決算(sim層の'monthEnd'イベントを受けて呼ばれる)。
  // 維持費をmoneyから差し引き、確定した台帳を履歴(直近LEDGER_HISTORY_LIMIT件)へpushし、
  // 新しい月の台帳を開始する。
  const handleMonthEnd = (event: Extract<SimEvent, { type: 'monthEnd' }>) => {
    const upkeep = calculateUpkeep(worldRef.current);
    const interest = monthlyInterest(loan);
    setMoney(m => m - upkeep - interest);

    // 確定した台帳。setCurrentLedgerのupdater内でsetLedgerHistoryを呼ぶと、
    // StrictModeがupdaterを二重実行して履歴が重複するため、updaterの外で組み立てる。
    const finalised: MonthlyLedger = {
      ...currentLedger, year: event.year, month: event.month, upkeep, interest,
    };
    setLedgerHistory(prev => [...prev, finalised].slice(-LEDGER_HISTORY_LIMIT));

    const nextMonth = event.month === 12 ? 1 : event.month + 1;
    const nextYear = event.month === 12 ? event.year + 1 : event.year;
    setCurrentLedger({
      year: nextYear, month: nextMonth, fares: 0, construction: 0, upkeep: 0, accidents: 0, interest: 0,
    });
  };

  // ★追加: 町の成長(sim層の'townGrowth'イベントを受けて呼ばれる)。
  // sim側は world.towns を差し替え済みなので、Reactのstateを同じ配列に合わせるだけ。
  const handleTownGrowth = (event: Extract<SimEvent, { type: 'townGrowth' }>) => {
    setTowns(event.towns);
  };

  // ★追加: 借入(LOAN_STEP単位)。上限までしか借りられない。
  const borrow = (amount: number = LOAN_STEP) => {
    const after = takeLoan({ money, loan }, amount);
    setMoney(after.money);
    setLoan(after.loan);
  };

  // ★追加: 返済(LOAN_STEP単位)。手持ちと借入残高の少ないほうまで。
  const repay = (amount: number = LOAN_STEP) => {
    const after = repayLoan({ money, loan }, amount);
    setMoney(after.money);
    setLoan(after.loan);
  };

  const deployTrain = (trainId: string) => {
    setTrains(prev => prev.map(t => {
      if (t.id === trainId) return { ...t, status: 'running' };
      return t;
    }));
    setSelectedTrainId(trainId);
  };

  const addSchedule = (trainId: string, stationId: string) => {
    if (!isEditingSchedule) return;
    // 種別に所属している列車の運行表を編集する場合は、路線の停車駅並びに足す
    // (同じ路線の他種別・他列車にも反映される)。
    const target = trains.find(t => t.id === trainId);
    const assignment = target ? resolveAssignment(target, lines, services) : null;
    if (assignment) {
      const lineId = assignment.line.id;
      setLines(prev => prev.map(l => (l.id === lineId ? { ...l, stops: [...l.stops, stationId] } : l)));
      return;
    }
    setTrains(prev => prev.map(t => (
      t.id === trainId ? { ...t, schedule: [...t.schedule, stationId] } : t
    )));
  };

  // --- 路線＋種別 ---

  /** 新しい路線を作る(既定種別「各停」を自動生成)。列車を指定するとその運行表を引き継いで所属させる。 */
  const createLine = (seedTrainId?: string) => {
    const seed = seedTrainId ? trains.find(t => t.id === seedTrainId) : undefined;
    const id = `l${Math.random().toString(36).slice(2, 8)}`;
    const { line, service } = createLineWithDefaultService(
      id, nextLineName(lines), nextLineColour(lines), seed ? [...seed.schedule] : [], 'loop'
    );
    setLines(prev => [...prev, line]);
    setServices(prev => [...prev, service]);
    if (seed) {
      setTrains(prev => prev.map(t => (t.id === seed.id ? { ...t, serviceId: service.id, scheduleIndex: 0 } : t)));
    }
    return line.id;
  };

  /** 路線に停車駅を追加する(地図上の駅クリックからの編集フロー用)。 */
  const addLineStop = (lineId: string, stationId: string) => {
    setLines(prev => prev.map(l => (l.id === lineId ? { ...l, stops: [...l.stops, stationId] } : l)));
  };

  const clearLineStops = (lineId: string) => {
    setLines(prev => prev.map(l => (l.id === lineId ? { ...l, stops: [] } : l)));
  };

  const renameLine = (lineId: string, name: string) => {
    setLines(prev => prev.map(l => (l.id === lineId ? { ...l, name } : l)));
  };

  // ★追加: 路線の運行モード(環状/折返し)を切り替える。
  const setLineMode = (lineId: string, mode: LineMode) => {
    setLines(prev => prev.map(l => (l.id === lineId ? { ...l, mode } : l)));
  };

  /** 路線を削除する。所属列車は現在の有効運行表を自前の運行表として引き継ぎ、単独運用に戻る。 */
  const deleteLine = (lineId: string) => {
    const lineServiceIds = new Set(services.filter(s => s.lineId === lineId).map(s => s.id));
    setTrains(prev => prev.map(t => {
      if (!t.serviceId || !lineServiceIds.has(t.serviceId)) return t;
      const schedule = effectiveSchedule(t, lines, services);
      const index = schedule.length > 0 ? t.scheduleIndex % schedule.length : 0;
      return { ...t, serviceId: undefined, schedule, scheduleIndex: index };
    }));
    setServices(prev => prev.filter(s => s.lineId !== lineId));
    setLines(prev => prev.filter(l => l.id !== lineId));
  };

  // 種別名の候補(未使用のものを先頭から選ぶ)。
  const SERVICE_NAME_PRESETS = ['各停', '快速', '特快', '急行', '準急', '特急'];

  /** 路線に新しい種別を追加する(既定: 通過駅なし・発車間隔なし)。 */
  const createService = (lineId: string): string => {
    const lineServices = services.filter(s => s.lineId === lineId);
    const used = new Set(lineServices.map(s => s.name));
    const name = SERVICE_NAME_PRESETS.find(n => !used.has(n)) ?? `種別${lineServices.length + 1}`;
    const id = `s${Math.random().toString(36).slice(2, 8)}`;
    const service: ServiceData = { id, lineId, name, skipStationIds: [], headwaySeconds: 0 };
    setServices(prev => [...prev, service]);
    return id;
  };

  const renameService = (serviceId: string, name: string) => {
    setServices(prev => prev.map(s => (s.id === serviceId ? { ...s, name } : s)));
  };

  const setServiceHeadway = (serviceId: string, headwaySeconds: number) => {
    setServices(prev => prev.map(s => (s.id === serviceId ? { ...s, headwaySeconds } : s)));
  };

  /** 駅の通過/停車を切り替える(skipStationIdsのトグル)。 */
  const toggleServiceStop = (serviceId: string, stationId: string) => {
    setServices(prev => prev.map(s => {
      if (s.id !== serviceId) return s;
      const skip = new Set(s.skipStationIds);
      if (skip.has(stationId)) skip.delete(stationId); else skip.add(stationId);
      return { ...s, skipStationIds: Array.from(skip) };
    }));
  };

  /**
   * 種別を削除する。路線の最後の1種別は削除できない(no-op)。
   * 所属列車は同じ路線の先頭種別へ付け替え、巡回位置を新しい有効運行表の長さに丸める。
   */
  const deleteService = (serviceId: string) => {
    const service = findService(services, serviceId);
    if (!service) return;
    const siblings = services.filter(s => s.lineId === service.lineId);
    if (siblings.length <= 1) return;
    const fallback = siblings.find(s => s.id !== serviceId);
    if (!fallback) return;
    const line = findLine(lines, service.lineId);
    const fallbackStops = line ? serviceStops(line, fallback) : [];
    setTrains(prev => prev.map(t => {
      if (t.serviceId !== serviceId) return t;
      const index = fallbackStops.length > 0 ? t.scheduleIndex % fallbackStops.length : 0;
      return { ...t, serviceId: fallback.id, scheduleIndex: index };
    }));
    setServices(prev => prev.filter(s => s.id !== serviceId));
  };

  /** 列車の所属種別を変える(nullで単独運用に戻す)。 */
  const assignTrainToService = (trainId: string, serviceId: string | null) => {
    setTrains(prev => prev.map(t => {
      if (t.id !== trainId) return t;
      const nextServiceId = serviceId ?? undefined;
      // 巡回位置は新しい有効運行表の長さを超えないように丸める
      const nextSchedule = nextServiceId
        ? effectiveSchedule({ ...t, serviceId: nextServiceId }, lines, services)
        : t.schedule;
      const len = nextSchedule.length;
      const index = len > 0 ? t.scheduleIndex % len : 0;
      return { ...t, serviceId: nextServiceId, scheduleIndex: index };
    }));
  };

  const selectTrain = (id: string | null) => {
    setSelectedTrainId(id);
    setIsEditingSchedule(false);
    setSelectedStationId(null);
    setSelectedDepotKey(null);
  };

  // ★追加: デッドロック救済用、列車のドラッグ置き直し(プラレールを掴んで動かす操作)。
  // 無料(コストは取らない)。置ければ次のstepWorldで経路が再検索される。
  // DynamicTrain/StationLabelがrunTimes Mapのインスタンス参照を保持し続けているため、
  // ここではworldRef上のMapを直接書き換える(setTrainsでの差し替えは不要)。
  const relocateTrainAt = (trainId: string, x: number, z: number): boolean => {
    return relocateTrain(worldRef.current, trainId, { x, z });
  };

  // ★追加: 駅選択(列車選択とは排他)。列車未選択かつスケジュール編集中でない場合のみ
  // GameScene側から呼ばれる。
  const selectStation = (id: string | null) => {
    setSelectedStationId(id);
    setSelectedTrainId(null);
    setSelectedDepotKey(null);
    setIsEditingSchedule(false);
  };

  // ★追加: ホームドアのアップグレード。ダウングレードは不可。
  const upgradeStationDoors = (stationId: string, doorType: PlatformDoorType) => {
    const target = stations.get(stationId);
    if (!target) return;
    if (doorType === 'standard' && target.platformDoors !== 'none') return;
    if (doorType === 'fullscreen' && target.platformDoors === 'fullscreen') return;

    const cost = doorType === 'fullscreen' ? PLATFORM_DOOR_FULLSCREEN_COST : PLATFORM_DOOR_STANDARD_COST;
    if (money < cost) return;

    setStations(prev => {
      const next = new Map(prev);
      const st = next.get(stationId);
      if (!st) return prev;
      next.set(stationId, { ...st, platformDoors: doorType });
      return next;
    });
    setMoney(m => m - cost);
  };

  // ★追加: 人身事故イベントの反映(賠償金の減算 + バナー通知の追加)
  const handleAccident = (event: Extract<SimEvent, { type: 'accident' }>) => {
    setMoney(m => m - event.penalty);
    setCurrentLedger(l => ({ ...l, accidents: l.accidents + event.penalty }));
    setActiveAccidents(prev => [...prev, { trainId: event.trainId, stationId: event.stationId, kind: event.kind }]);
  };

  // PM3フォローアップ: デッドセクション失速からの救援コスト(1回だけ課金)。
  // handleAccidentと同じ「イベント→setMoneyで即時減算」の最小構成にした。
  // MonthlyLedgerには専用フィールドを増やさず(既存のaccidentsとは性質が違う一時費用
  // のため流用しない)、progress/play-modes-plan.mdに設計判断として記録する。
  const handleStallRescue = (event: Extract<SimEvent, { type: 'stallRescue' }>) => {
    setMoney(m => m - event.penalty);
  };

  // ★追加: スケジュールコピー機能
  const copySchedule = (trainId: string) => {
    const target = trains.find(t => t.id === trainId);
    if (target) {
      setScheduleClipboard([...target.schedule]);
    }
  };

  // ★追加: スケジュールペースト機能
  const pasteSchedule = (trainId: string) => {
    if (!scheduleClipboard) return;
    setTrains(prev => prev.map(t => {
      if (t.id === trainId) {
        return { ...t, schedule: [...scheduleClipboard], scheduleIndex: 0 };
      }
      return t;
    }));
  };

  // ★追加: セーブ／ロード
  const saveGame = () => {
    const saveData = serialiseWorld(
      railMap, stations, trains, worldRef.current.runtimes, worldRef.current.waiting, money, towns, worldSeed,
      worldRef.current.clock ?? { elapsed: 0 }, currentLedger, ledgerHistory, stopLocation,
      lines, services, worldRef.current.serviceDepartures ?? new Map(), loan,
      worldRef.current.demand ?? new Map(), halfExtent, cornerDiffs, townDensity, terrainProfile, gameRules
    );
    localStorage.setItem(SAVE_KEY, JSON.stringify(saveData));
  };

  const loadGame = () => {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) {
      console.warn('No save data found.');
      return;
    }
    const saveData = JSON.parse(raw) as SaveData;
    const restored = deserialiseWorld(saveData);
    if (!restored) {
      console.warn('Save data is incompatible with the current version and was discarded.');
      return;
    }

    setRailMap(restored.railMap);
    setStations(restored.stations);
    setTrains(restored.trains);
    setMoney(restored.money);
    setLoan(restored.loan);
    setTowns(restored.towns);
    setTownDensity(restored.townDensity);
    setTerrainProfile(restored.terrainProfile);
    setGameRules(restored.rules);
    setWorldSeed(restored.seed);
    setCornerDiffs(restored.cornerDiffs);
    setDebugFieldOverride(null);
    setCurrentLedger(restored.currentLedger);
    setLedgerHistory(restored.ledgerHistory);
    setStopLocation(restored.stopLocation);
    setLines(restored.lines);
    setServices(restored.services);

    // runtimes/waiting は DynamicTrain/StationLabel が Map インスタンスを参照し続けているため、
    // 差し替えず中身だけ入れ替える。clockも同様にworldRef上のオブジェクトを直接更新する。
    worldRef.current.runtimes.clear();
    restored.runtimes.forEach((rt, id) => worldRef.current.runtimes.set(id, rt));
    worldRef.current.waiting.clear();
    restored.waiting.forEach((count, id) => worldRef.current.waiting.set(id, count));
    worldRef.current.clock = restored.clock;
    worldRef.current.stopLocation = restored.stopLocation;
    worldRef.current.lines = restored.lines;
    worldRef.current.services = restored.services;
    worldRef.current.serviceDepartures = restored.serviceDepartures;
    worldRef.current.demand = restored.demand;
    // 経路キャッシュは列車・運行表が入れ替わったので捨てる(次のstepWorldで組み直される)。
    worldRef.current.serviceSignature = undefined;
  };

  /**
   * 起動時デバッグ用のシナリオ世界を読み込む。セーブデータは変更しない。
   * 引数省略時は従来の「坂・高架・往復列車」。シナリオ一覧はsim/debugScenarios.tsを参照。
   */
  const loadDebugScenario = (scenario: DebugScenarioWorld = createDebugScenario()) => {
    setRailMap(scenario.railMap);
    setStations(scenario.stations);
    setTrains(scenario.trains);
    if (scenario.worldSeedOverride !== undefined) {
      setWorldSeed(scenario.worldSeedOverride);
      setCornerDiffs(new Map());
      setDebugFieldOverride(null);
    } else {
      const overrideField = scenario.field ?? fieldFromMaps(new Map(), new Map(), halfExtent);
      setDebugFieldOverride(overrideField);
      // R4d: wgpu レンダラーは (seed, halfExtent) からしか地形を作れないため、手組みの
      // 上書きfieldをそのまま使うと「TS側は平地・描画側はランダムな丘」になり、線路や駅が
      // 丘に埋もれて見えなくなる。全域ぶんのコーナー標高をオーバーレイ差分として転送し、
      // 描画側の地形を上書きfieldへ揃える(sim/terrainOverlay.ts の cornerDiffsFromField)。
      setCornerDiffs(cornerDiffsFromField(overrideField, halfExtent, scenario.fieldBounds));
    }
    setTowns(scenario.towns ?? []);
    setLines(scenario.lines ?? []);
    setServices(scenario.services ?? []);
    if (scenario.money !== undefined) setMoney(scenario.money);
    setSelectedTrainId(null);
    setSelectedStationId(null);
    worldRef.current.runtimes.clear();
    worldRef.current.waiting.clear();
    worldRef.current.demand = new Map();
    worldRef.current.clock = { elapsed: 0 };
    worldRef.current.serviceSignature = undefined;
  };

  /**
   * ★追加(P5): 新規ゲーム開始(マップサイズ選択UIから呼ぶ)。所持金・列車・線路など
   * 全状態を初期化し、新しいworldSeed・指定halfExtent・指定地形プロファイルで
   * 地形・町を作り直す。
   * halfExtentが変わるとbaseFieldのuseMemoも再計算されるため、生成した町は
   * generateRegionTownsに渡すfieldをここで直接作る(baseFieldのuseMemo更新を待たない)。
   */
  const newGame = (
    selectedHalfExtent: number,
    selectedDensity: TownDensity = 'normal',
    selectedProfile: TerrainProfile = DEFAULT_TERRAIN_PROFILE,
    selectedRules: GameRules = DEFAULT_GAME_RULES
  ) => {
    const seed = Date.now() % 2 ** 31;
    const newField = createTerrainField(seed, selectedHalfExtent, selectedProfile);
    setHalfExtent(selectedHalfExtent);
    setTerrainProfile(selectedProfile);
    setGameRules(selectedRules);
    setWorldSeed(seed);
    setCornerDiffs(new Map());
    setDebugFieldOverride(null);
    setRailMap(new Map());
    setStations(new Map());
    setTrains([]);
    setTownDensity(selectedDensity);
    setTowns(generateRegionTowns(seed + 1, selectedHalfExtent, newField, selectedDensity));
    setLines([]);
    setServices([]);
    setMoney(STARTING_MONEY);
    setLoan(0);
    setCurrentLedger(emptyLedger());
    setLedgerHistory([]);
    setSelectedTrainId(null);
    setSelectedStationId(null);
    worldRef.current.runtimes.clear();
    worldRef.current.waiting.clear();
    worldRef.current.demand = new Map();
    worldRef.current.clock = { elapsed: 0 };
    worldRef.current.serviceSignature = undefined;
  };

  return {
    railMap, setRailMap,
    stations, setStations,
    trains, setTrains,
    towns,
    townDensity,
    townTileIndex,
    newGame,
    field,
    // 地形のシード。WebGPUレンダラー(renderer/)は同じ seed + halfExtent から
    // 地形を自前で生成するため、描画側にもそのまま渡す。
    worldSeed,
    terrainProfile,
    gameRules,
    baseField,
    editedField,
    cornerDiffs,
    halfExtent,
    selectedTrainId, setSelectedTrainId: selectTrain,
    isEditingSchedule, setIsEditingSchedule,
    commitPath, removeSignal,
    handleTrainArrive,
    buyTrain, deployTrain, sellTrain,
    selectedDepotKey, selectDepot,
    addCar, removeCar,
    addSchedule,
    worldRef,
    relocateTrainAt,
    // 公開
    scheduleClipboard,
    copySchedule,
    pasteSchedule,
    saveGame,
    loadGame,
    loadDebugScenario,
    // ★追加: 経済システム
    money,
    addIncome,
    // ★追加: 借入
    loan,
    borrow,
    repay,
    // ★追加: 人身事故とホームドア
    selectedStationId,
    selectStation,
    upgradeStationDoors,
    activeAccidents,
    handleAccident,
    handleStallRescue,
    // ★追加: 月次決算(収支台帳)
    currentLedger,
    ledgerHistory,
    handleMonthEnd,
    handleTownGrowth,
    // ★追加: 駅停車位置設定(Near/Middle/Far)
    stopLocation,
    setStopLocation,
    // ★追加: 路線＋種別(共有運行表＋発車間隔)
    lines,
    services,
    createLine,
    addLineStop,
    clearLineStops,
    renameLine,
    setLineMode,
    deleteLine,
    createService,
    renameService,
    setServiceHeadway,
    toggleServiceStop,
    deleteService,
    assignTrainToService,
  };
};
