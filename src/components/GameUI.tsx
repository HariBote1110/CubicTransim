import React, { useEffect, useMemo, useState } from 'react';
import type { CellData, CellType, TrainData, LineData, ServiceData, StationData, PlatformDoorType, RailGauge, RailWeight, TrainPower, SignalKind, TrainProtection } from '../types';
import { DEFAULT_GAUGE } from '../types';
import {
  RAIL_COST, STATION_COST, DEPOT_COST, SIGNAL_COST, TERRAIN_EDIT_COST, CAPACITY_PER_CAR,
  CAR_COST, CAR_REFUND, SUBSTATION_COST,
  PLATFORM_DOOR_STANDARD_COST, PLATFORM_DOOR_FULLSCREEN_COST,
  demandFactor, clockToDate,
} from '../sim/economy';
import type { MonthlyLedger } from '../sim/economy';
import { ANNUAL_INTEREST_RATE, LOAN_LIMIT, LOAN_STEP, maxAdditionalLoan, monthlyInterest } from '../sim/loans';
import type { PassengerCohort } from '../sim/passengers';
import { evaluateBuild } from '../sim/buildPreview';
import type { TownTileIndex } from '../sim/townTiles';
import {
  effectiveSchedule, resolveAssignment,
  membersOf, HEADWAY_CHOICES, averageInterval, suggestsShuttle,
} from '../sim/lines';
import type { LineMode } from '../sim/lines';
import type { BuildPreview } from '../sim/buildPreview';
import type { SimWorld } from '../sim/simulation';
import { occupiedCellKeysFromRuntimes } from '../sim/simulation';
import { computeStationArrivals } from '../sim/arrivals';
import type { StationArrival } from '../sim/arrivals';
import type { AccidentNotice } from '../hooks/useGameLogic';
import { T, panel, button, sectionLabel, formatYen } from '../ui/theme';
import { MAX_ELEVATED_LEVEL, stepElevatedLevel } from '../sim/trackPath';
import type { BuildLevel, StationAxis } from '../sim/construction';
import { UNDERGROUND_RAIL_COST_MULTIPLIER, UNDERGROUND_STATION_COST } from '../sim/economy';
import type { TerrainField } from '../sim/terrainField';
import type { EditedTerrainField } from '../sim/terrainOverlay';
import { buildEditBlockers } from '../sim/terrainOverlay';
import type { GameRules } from '../sim/gameRules';
import type { RailBuildOptions } from '../sim/construction';
import { REGAUGE_COST_PER_CELL, trainCostForProtected, PROTECTION_COST } from '../sim/economy';

// ゲーム内日付表示の更新間隔(ms)。他のポーリングと同様、低頻度で十分。
const CLOCK_POLL_INTERVAL_MS = 500;
// 選択中列車の乗客数・駅の待ち人数の更新間隔(ms)。
const POLL_INTERVAL_MS = 400;

// PM2 Stage B: 改軌ツール。rules.gauge=trueのときだけ'regauge'ツールボタンを表示する。
export type BuildMode = CellType | 'none' | 'remove' | 'signal' | 'raise' | 'lower' | 'regauge';

// PM2: 軌間の選択肢(基本ラインナップ2種+拡張ラインナップ2種)。
const BASIC_GAUGES: { value: RailGauge; label: string }[] = [
  { value: DEFAULT_GAUGE, label: '狭軌' },
  { value: 1435, label: '標準軌' },
];
const EXTENDED_GAUGES: { value: RailGauge; label: string }[] = [
  { value: 762, label: '特殊狭軌' },
  { value: 1372, label: '馬車軌間' },
];

// 軌道(何キロレール): レール種別の選択肢(リアリスティックのみ)。
const RAIL_WEIGHT_OPTIONS: { value: RailWeight; label: string; hint: string }[] = [
  { value: 37, label: '37kg', hint: '軽量・安価(速度上限70km/h、許容軸重12t)。コスト×0.8' },
  { value: 50, label: '50kgN', hint: '標準(速度上限110km/h、許容軸重16t)。コスト×1.0' },
  { value: 60, label: '60kg', hint: '重量・高価(速度上限なし、軸重無制限)。コスト×1.3' },
];

// S2: 信号種別の選択肢(progress/signalling-plan.md)。
const SIGNAL_KIND_OPTIONS: { value: SignalKind; label: string; hint: string }[] = [
  { value: 'block', label: '閉塞', hint: 'ブロック全体の占有で他列車の進入を止める(既定)' },
  { value: 'home', label: '場内', hint: '同じブロック内でも、自分の経路セルが他列車と重ならなければ進入できる(駅構内向け)' },
  { value: 'departure', label: '出発', hint: '停車中はこの先を予約しない。発車後は先のブロックが空くまで待つ' },
];

// S3: 保安装置の選択肢(progress/signalling-plan.md)。
const PROTECTION_OPTIONS: { value: TrainProtection | undefined; label: string; hint: string }[] = [
  { value: undefined, label: 'なし', hint: '無防備。信号冒進(SPAD)の確率が最も高い' },
  { value: 'ats-s', label: 'ATS-S', hint: `警報のみ(確認で通過できる)。地上設備 +¥${PROTECTION_COST['ats-s']}/マス` },
  { value: 'ats-p', label: 'ATS-P', hint: `パターン照査で自動ブレーキ。地上設備 +¥${PROTECTION_COST['ats-p']}/マス` },
  { value: 'atc', label: 'ATC', hint: `車内信号・段階速度制御。地上設備 +¥${PROTECTION_COST.atc}/マス` },
  { value: 'cbtc', label: 'CBTC', hint: `無線移動閉塞。地上設備 +¥${PROTECTION_COST.cbtc}/マス。車上装置も揃えば移動閉塞になる` },
];

interface GameUIProps {
  buildMode: BuildMode;
  setBuildMode: (mode: BuildMode) => void;
  // ★変更: 線路(rail)・駅(station)ツールの建設対象レベル(0=地平〜MAX_ELEVATED_LEVEL)。
  buildLevel: BuildLevel;
  setBuildLevel: (level: BuildLevel) => void;
  selectedTrainId: string | null;
  trains: TrainData[];
  stations: Map<string, StationData>;
  railMap: Map<string, CellData>;
  field: TerrainField;
  /** 編集差分を含まない基底field。地形編集(盛土/切土)プレビューのブロック判定に使う。 */
  baseField: TerrainField;
  /** 編集差分を合成したfield(=field自身と同じ実体)。applyCornerEditの入力に使う。 */
  editedField: EditedTerrainField;
  /** マップの生成半径。地形編集の範囲外判定に使う。 */
  halfExtent: number;
  /** 町タイル索引(useGameLogicのtownTileIndex)。建設プレビューの可否判定に使う。 */
  townTiles: TownTileIndex;
  isEditingSchedule: boolean;
  setIsEditingSchedule: (v: boolean) => void;
  onDeploy: (trainId: string) => void;
  onAddCar: (trainId: string) => void;
  onRemoveCar: (trainId: string) => void;
  scheduleClipboard: string[] | null;
  onCopySchedule: (trainId: string) => void;
  onPasteSchedule: (trainId: string) => void;
  simSpeed: 0 | 1 | 2 | 4;
  setSimSpeed: (speed: 0 | 1 | 2 | 4) => void;
  onSave: () => void;
  onLoad: () => void;
  money: number;
  world: React.RefObject<SimWorld>;
  selectedStationId: string | null;
  onUpgradeDoors: (stationId: string, doorType: PlatformDoorType) => void;
  accidents: AccidentNotice[];
  currentLedger: MonthlyLedger;
  ledgerHistory: MonthlyLedger[];
  // ★追加: 借入(資金繰り)
  loan: number;
  onBorrow: (amount?: number) => void;
  onRepay: (amount?: number) => void;
  stopLocation: 'near' | 'middle' | 'far';
  onSetStopLocation: (loc: 'near' | 'middle' | 'far') => void;
  /** 建設プレビュー中のセル列(GameSceneのカーソル/ドラッグから流れてくる) */
  previewPath: { x: number; z: number }[];
  // ★追加: 路線＋種別(共有運行表＋発車間隔)
  lines: LineData[];
  services: ServiceData[];
  onCreateLine: (seedTrainId?: string) => string;
  onClearLineStops: (lineId: string) => void;
  onRenameLine: (lineId: string, name: string) => void;
  onSetLineMode: (lineId: string, mode: LineMode) => void;
  onDeleteLine: (lineId: string) => void;
  onCreateService: (lineId: string) => string;
  onRenameService: (serviceId: string, name: string) => void;
  onSetServiceHeadway: (serviceId: string, headwaySeconds: number) => void;
  onToggleServiceStop: (serviceId: string, stationId: string) => void;
  onDeleteService: (serviceId: string) => void;
  onAssignService: (trainId: string, serviceId: string | null) => void;
  // PM2: プレイモードのルールフラグ集合。rules.gauge=falseなら軌間/電化UIは一切出さない。
  gameRules: GameRules;
  // PM2: 線路(rail)ツール専用の軌間/電化選択。
  railOptions: RailBuildOptions;
  setRailOptions: (opts: RailBuildOptions) => void;
  // PM2 Stage B: 改軌ツール専用の目的軌間。
  regaugeTargetGauge: RailGauge | undefined;
  setRegaugeTargetGauge: (gauge: RailGauge | undefined) => void;
  // PM2: 車庫(depot)ツールで列車を購入するときの動力方式選択。
  purchasePower: TrainPower;
  setPurchasePower: (power: TrainPower) => void;
  // S2: 信号(signal)ツール専用の種別選択。rules.signalling==='s2'のときだけUIに出す。
  signalKind: SignalKind;
  setSignalKind: (kind: SignalKind) => void;
  // S3: 車庫(depot)ツールで列車を購入するときの保安装置選択。rules.signalling==='s3'のみ。
  purchaseProtection: TrainProtection | undefined;
  setPurchaseProtection: (protection: TrainProtection | undefined) => void;
  // OpenTTD式の駅方向指定: 駅(station)ツールでプレイヤーが選ぶ軸('ns'/'ew')。
  // 地平駅の建設判定で権威的に使う(高架/地下駅は別機構のため参照しない)。
  stationAxis: StationAxis;
  setStationAxis: (axis: StationAxis) => void;
}

// --- 建設ツールの定義(表記は日本語に統一し、ショートカットキーを併記する) ---
const BUILD_TOOLS: {
  mode: BuildMode;
  label: string;
  key: string;
  accent: string;
  cost?: string;
  hint: string;
}[] = [
  { mode: 'none', label: '選択', key: '1', accent: '#8b98a6', hint: '列車や駅をクリックして選ぶ' },
  { mode: 'rail', label: '線路', key: '2', accent: T.accent, cost: `¥${RAIL_COST}/マス`, hint: `ドラッグで敷設。水上は橋(5倍)、山は隧道(8倍)、地下は掘割(${UNDERGROUND_RAIL_COST_MULTIPLIER}倍)。高架/地下の端に当てると坂で自動接続。↑/↓で建設レベル(高架/地下)を切替` },
  { mode: 'station', label: '駅', key: '3', accent: T.station, cost: `¥${STATION_COST.toLocaleString()}`, hint: `線路の上に置くと隣接セルと繋がって長いホームになる。地下駅は¥${UNDERGROUND_STATION_COST.toLocaleString()}。↑/↓で建設レベル(高架/地下)を切替` },
  { mode: 'depot', label: '車庫', key: '4', accent: T.depot, cost: `¥${DEPOT_COST.toLocaleString()}`, hint: '車庫をクリックすると列車を購入できる' },
  { mode: 'signal', label: '信号', key: '5', accent: T.signal, cost: `¥${SIGNAL_COST.toLocaleString()}`, hint: 'Shift+クリックで撤去' },
  { mode: 'remove', label: '撤去', key: '6', accent: T.danger, cost: '無料', hint: '払い戻しはありません' },
  { mode: 'raise', label: '盛土', key: '7', accent: T.terrain, cost: `¥${TERRAIN_EDIT_COST}/マス`, hint: 'ドラッグした矩形範囲を1段盛り上げる。段差1以下を保つため周囲も自動でならされる(その分も課金)。線路・町・水の上は不可' },
  { mode: 'lower', label: '切土', key: '8', accent: T.terrain, cost: `¥${TERRAIN_EDIT_COST}/マス`, hint: 'ドラッグした矩形範囲を1段掘り下げる。段差1以下を保つため周囲も自動でならされる(その分も課金)。線路・町・水の上は不可' },
  // PM2 Stage B: rules.gauge=trueのときだけツールバーに表示する(BUILD_TOOLSからの
  // フィルタは描画側で行う。BUILD_TOOLSはキーボードショートカット判定にも使うため、
  // 定義自体は常に含めておく)。
  { mode: 'regauge', label: '改軌', key: '9', accent: T.bridge, cost: `¥${REGAUGE_COST_PER_CELL}/マス`, hint: '既存の線路をドラッグして軌間を変換する。列車が在線中の区間は不可' },
  // PM4: rules.electrification==='feeding'(リアリスティック)のときだけツールバーに表示する
  // (BUILD_TOOLSからのフィルタは描画側で行う。regaugeと同じ規約)。
  { mode: 'substation', label: '変電所', key: '0', accent: T.depot, cost: `¥${SUBSTATION_COST.toLocaleString()}`, hint: '電化線路に隣接する空きマスに設置。き電区間へ給電する' },
];

const SPEEDS: (0 | 1 | 2 | 4)[] = [0, 1, 2, 4];

const DOOR_LABEL: Record<PlatformDoorType, string> = {
  none: 'なし',
  standard: '標準',
  fullscreen: 'フルスクリーン',
};

const STOP_LOCATION_LABEL = {
  near: '手前',
  middle: '中央',
  far: '奥',
} as const;

export const GameUI: React.FC<GameUIProps> = ({
  buildMode, setBuildMode,
  buildLevel, setBuildLevel,
  selectedTrainId, trains, stations, railMap, field, baseField, editedField, halfExtent, townTiles,
  isEditingSchedule, setIsEditingSchedule,
  onDeploy, onAddCar, onRemoveCar,
  scheduleClipboard, onCopySchedule, onPasteSchedule,
  simSpeed, setSimSpeed,
  onSave, onLoad,
  money, world,
  selectedStationId, onUpgradeDoors, accidents,
  currentLedger, ledgerHistory,
  loan, onBorrow, onRepay,
  stopLocation, onSetStopLocation,
  previewPath,
  lines, services, onCreateLine, onClearLineStops, onRenameLine, onSetLineMode, onDeleteLine,
  onCreateService, onRenameService, onSetServiceHeadway, onToggleServiceStop, onDeleteService, onAssignService,
  gameRules, railOptions, setRailOptions, regaugeTargetGauge, setRegaugeTargetGauge,
  purchasePower, setPurchasePower, signalKind, setSignalKind,
  purchaseProtection, setPurchaseProtection,
  stationAxis, setStationAxis,
}) => {
  const [gameDate, setGameDate] = useState({ year: 1, month: 1, day: 1 });
  const [openPanel, setOpenPanel] = useState<'none' | 'finance' | 'settings' | 'lines'>('none');
  const [passengers, setPassengers] = useState(0);
  // 選択中の列車が経路待ちで動けていない秒数(TrainRuntime.waitTimer)。長時間ならUIで警告する。
  const [stuckSeconds, setStuckSeconds] = useState(0);
  const [stationWaiting, setStationWaiting] = useState(0);
  const [stationDemand, setStationDemand] = useState(0);
  // 選択中の駅の待ち客の行き先内訳(多い順)。
  const [stationDestinations, setStationDestinations] = useState<PassengerCohort[]>([]);
  // 選択中の駅の発車標(接近案内)。到着が早い順。
  const [stationArrivals, setStationArrivals] = useState<StationArrival[]>([]);
  // 路線パネルで停車駅ごとの待ち人数を出すための、駅id→待ち人数。
  const [waitingByStation, setWaitingByStation] = useState<Map<string, number>>(new Map());
  // 種別id→実績の平均運転間隔(秒)。設定値どおりに走れているかを見るため。
  const [actualIntervals, setActualIntervals] = useState<Map<string, number>>(new Map());

  // sim層が持つ値(時計・乗客数・待ち人数)は毎tick変わるため、UIからは低頻度でポーリングする。
  useEffect(() => {
    const id = setInterval(() => {
      setGameDate(clockToDate(world.current?.clock?.elapsed ?? 0));
    }, CLOCK_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [world]);

  useEffect(() => {
    const id = setInterval(() => {
      setPassengers(selectedTrainId ? (world.current?.runtimes.get(selectedTrainId)?.passengers ?? 0) : 0);
      setStuckSeconds(selectedTrainId ? (world.current?.runtimes.get(selectedTrainId)?.waitTimer ?? 0) : 0);
      setWaitingByStation(new Map(world.current?.waiting ?? []));
      const samples = world.current?.serviceIntervals;
      setActualIntervals(new Map(
        samples
          ? services.map(s => [s.id, averageInterval(samples, s.id)] as const)
              .filter((entry): entry is readonly [string, number] => entry[1] !== null)
          : []
      ));

      if (!selectedStationId) {
        setStationWaiting(0);
        setStationDemand(0);
        setStationDestinations([]);
        setStationArrivals([]);
        return;
      }
      setStationWaiting(Math.floor(world.current?.waiting.get(selectedStationId) ?? 0));
      const cohorts = world.current?.demand?.get(selectedStationId) ?? [];
      setStationDestinations([...cohorts].sort((a, b) => b.count - a.count).slice(0, 5));
      const station = stations.get(selectedStationId);
      setStationDemand(station ? demandFactor(station.center, world.current?.towns ?? []) : 0);
      // 発車標: 駅を選んでいるときだけ計算する(全駅ぶんを毎回計算しない)。
      setStationArrivals(
        world.current
          ? computeStationArrivals(selectedStationId, world.current.trains, world.current.runtimes, lines, services)
          : []
      );
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [selectedTrainId, selectedStationId, world, stations, lines, services]);

  // キーボードショートカット: 1〜6で建設モード、Spaceで一時停止、Escで選択解除。
  // 線路(rail)・駅(station)ツール選択中はArrowUp/Downで建設レベルを0(地平)〜
  // MAX_ELEVATED_LEVELまで±1する(状態遷移そのものはsim/trackPath.tsのstepElevatedLevelに委譲)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const tool = BUILD_TOOLS.find(t => t.key === e.key
        && (t.mode !== 'regauge' || gameRules.gauge)
        && (t.mode !== 'substation' || gameRules.electrification === 'feeding'));
      if (tool) { setBuildMode(tool.mode); return; }
      if (e.code === 'Space') { e.preventDefault(); setSimSpeed(simSpeed === 0 ? 1 : 0); return; }
      if (e.key === 'Escape') { setBuildMode('none'); setOpenPanel('none'); return; }
      if ((buildMode === 'rail' || buildMode === 'station')
        && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        // P8c: stepElevatedLevelは-MAX_ELEVATED_LEVEL(地下)〜+MAX_ELEVATED_LEVEL(高架)まで
        // 0をまたいで対称にステップする。ArrowUpは地表へ近づく/高架側へ、ArrowDownは
        // 地下側へ向かう(既存の高架の向きをそのまま地下へ延長しただけ)。
        setBuildLevel(stepElevatedLevel(buildLevel, e.key === 'ArrowUp' ? 1 : -1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setBuildMode, setSimSpeed, simSpeed, buildMode, buildLevel, setBuildLevel, gameRules.gauge, gameRules.electrification]);

  const selectedTrain = trains.find(t => t.id === selectedTrainId);
  const selectedStation = selectedStationId ? stations.get(selectedStationId) : undefined;
  const activeTool = BUILD_TOOLS.find(t => t.mode === buildMode);

  // 建設プレビュー(コスト・可否)。建設ロジックそのものに問い合わせて判定する。
  const preview = useMemo(() => {
    if (buildMode === 'none' || previewPath.length === 0) return null;
    const blockers = buildEditBlockers({ halfExtent, railMap, townTileIndex: townTiles, baseField });
    return evaluateBuild(buildMode, previewPath, railMap, stations, field, money, buildLevel, townTiles, {
      base: baseField, editedField, blockers,
    }, buildMode === 'rail' ? railOptions : {}, buildMode === 'regauge'
      // H4: commitPath(useGameLogic.ts)と同じくoccupiedCellKeysFromRuntimesで
      // 走行中の実位置を見る。省略(=常に空集合)だとプレビューが実際の可否と食い違う。
      ? { targetGauge: regaugeTargetGauge ?? DEFAULT_GAUGE, occupiedCells: occupiedCellKeysFromRuntimes(world.current?.runtimes ?? new Map()) }
      : undefined,
    stationAxis);
  }, [buildMode, previewPath, railMap, stations, field, baseField, editedField, money, buildLevel, townTiles, halfExtent, railOptions, regaugeTargetGauge, world, stationAxis]);

  // 折返し推奨の判定は経路探索を伴うので、路線・線路・駅が変わったときだけ計算する。
  // suggestsShuttleは物理経路(路線のstops)に対して評価する(種別のサブセットではない)。
  const shuttleSuggestions = useMemo(
    () => new Map(lines.map(l => [l.id, suggestsShuttle(l.stops, railMap, stations)])),
    [lines, railMap, stations]
  );

  const monthProfit =
    currentLedger.fares - currentLedger.construction - currentLedger.upkeep
    - currentLedger.accidents - currentLedger.interest;

  return (
    <>
      {/* ===== 左上: 資金と選択中の対象 ===== */}
      <div style={panel({ position: 'absolute', top: 16, left: 16, width: 264, zIndex: 10, overflow: 'hidden' })}>
        <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${T.line}` }}>
          <div style={{ fontSize: 11, letterSpacing: '0.14em', color: T.textFaint, fontWeight: 700 }}>
            CUBICTRANSIM
          </div>
          <div style={{
            fontSize: 24, fontWeight: 700, marginTop: 2,
            color: money < 0 ? T.danger : T.text, fontVariantNumeric: 'tabular-nums',
          }}>
            {formatYen(money)}
          </div>
          <div style={{ fontSize: 11.5, color: monthProfit >= 0 ? T.positive : T.danger, marginTop: 1 }}>
            今月 {formatYen(monthProfit)}
          </div>
          {loan > 0 && (
            <div style={{ fontSize: 11.5, color: T.textFaint, marginTop: 1 }}>
              借入 {formatYen(loan)}（月利息 {formatYen(monthlyInterest(loan))}）
            </div>
          )}
        </div>

        <div style={{ padding: '11px 14px 13px' }}>
          {selectedTrain ? (
            <TrainInspector
              train={selectedTrain}
              stations={stations}
              passengers={passengers}
              stuckSeconds={stuckSeconds}
              money={money}
              isEditingSchedule={isEditingSchedule}
              setIsEditingSchedule={setIsEditingSchedule}
              onDeploy={onDeploy}
              onAddCar={onAddCar}
              onRemoveCar={onRemoveCar}
              scheduleClipboard={scheduleClipboard}
              onCopySchedule={onCopySchedule}
              onPasteSchedule={onPasteSchedule}
              lines={lines}
              services={services}
              onCreateLine={onCreateLine}
              onAssignService={onAssignService}
            />
          ) : selectedStation ? (
            <StationInspector
              station={selectedStation}
              waiting={stationWaiting}
              destinations={stationDestinations}
              arrivals={stationArrivals}
              stations={stations}
              demand={stationDemand}
              money={money}
              onUpgradeDoors={onUpgradeDoors}
            />
          ) : (
            <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
              列車・駅・車庫をクリックすると、ここに詳細が出ます。
              <div style={{ marginTop: 8, color: T.textFaint, fontSize: 11.5 }}>
                {activeTool ? `${activeTool.label}: ${activeTool.hint}` : ''}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ===== 上中央: 時間の操作 ===== */}
      <div style={{
        position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 8, zIndex: 10, pointerEvents: 'none',
      }}>
        <div style={panel({ display: 'flex', alignItems: 'center', gap: 4, padding: 4 })}>
          {SPEEDS.map(s => (
            <button
              key={s}
              onClick={() => setSimSpeed(s)}
              style={{ ...button({ active: simSpeed === s, compact: true }), minWidth: 34 }}
              title={s === 0 ? '一時停止 (Space)' : `${s}倍速`}
            >
              {s === 0 ? '❚❚' : `${s}x`}
            </button>
          ))}
          <div style={{ width: 1, alignSelf: 'stretch', background: T.line, margin: '2px 4px' }} />
          <div style={{
            padding: '0 10px', fontSize: 12.5, fontWeight: 600, color: T.text,
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          }}>
            {gameDate.year}年{gameDate.month}月{gameDate.day}日
          </div>
        </div>
      </div>

      {/* ===== 右上: 収支・設定・セーブ ===== */}
      <div style={{
        position: 'absolute', top: 16, right: 16, zIndex: 10,
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
      }}>
        <div style={panel({ display: 'flex', gap: 4, padding: 4 })}>
          <button
            onClick={() => setOpenPanel(p => (p === 'finance' ? 'none' : 'finance'))}
            style={button({ active: openPanel === 'finance', accent: T.positive, compact: true })}
          >
            収支
          </button>
          <button
            onClick={() => setOpenPanel(p => (p === 'lines' ? 'none' : 'lines'))}
            style={button({ active: openPanel === 'lines', accent: T.station, compact: true })}
          >
            路線
          </button>
          <button
            onClick={() => setOpenPanel(p => (p === 'settings' ? 'none' : 'settings'))}
            style={button({ active: openPanel === 'settings', compact: true })}
          >
            設定
          </button>
          <div style={{ width: 1, alignSelf: 'stretch', background: T.line, margin: '2px' }} />
          <button onClick={onSave} style={button({ compact: true })}>保存</button>
          <button onClick={onLoad} style={button({ compact: true })}>読込</button>
        </div>

        {openPanel === 'settings' && (
          <div style={panel({ padding: 14, width: 260 })}>
            <div style={sectionLabel}>駅での停車位置</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['near', 'middle', 'far'] as const).map(loc => (
                <button
                  key={loc}
                  onClick={() => onSetStopLocation(loc)}
                  style={{ ...button({ active: stopLocation === loc, compact: true }), flex: 1 }}
                >
                  {STOP_LOCATION_LABEL[loc]}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 8, lineHeight: 1.6 }}>
              編成がホームのどこに止まるかを決めます。編成がホームより長い場合は、
              設定によらず奥端で停車します。
            </div>
          </div>
        )}

        {openPanel === 'lines' && (
          <LinePanel
            lines={lines}
            services={services}
            trains={trains}
            stations={stations}
            waitingByStation={waitingByStation}
            actualIntervals={actualIntervals}
            shuttleSuggestions={shuttleSuggestions}
            onCreateLine={onCreateLine}
            onClearLineStops={onClearLineStops}
            onRenameLine={onRenameLine}
            onSetLineMode={onSetLineMode}
            onDeleteLine={onDeleteLine}
            onCreateService={onCreateService}
            onRenameService={onRenameService}
            onSetServiceHeadway={onSetServiceHeadway}
            onToggleServiceStop={onToggleServiceStop}
            onDeleteService={onDeleteService}
            onAssignService={onAssignService}
          />
        )}

        {openPanel === 'finance' && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <LoanPanel loan={loan} money={money} onBorrow={onBorrow} onRepay={onRepay} />
            <FinancePanel currentLedger={currentLedger} ledgerHistory={ledgerHistory} />
          </div>
        )}
      </div>

      {/* ===== 事故バナー ===== */}
      {accidents.length > 0 && (
        <div style={{
          position: 'absolute', top: 74, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', flexDirection: 'column', gap: 6, pointerEvents: 'none', zIndex: 20,
        }}>
          {accidents.map((a, i) => (
            <div key={`${a.trainId}-${i}`} style={panel({
              background: 'rgba(153, 27, 27, 0.92)', border: '1px solid rgba(255,255,255,0.22)',
              padding: '8px 14px', fontSize: 12.5, fontWeight: 700, color: '#fff',
            })}>
              {a.kind === 'spad'
                ? `⚠ ${a.stationId} で信号冒進(SPAD) — 運転見合わせ中`
                : `⚠ ${stations.get(a.stationId)?.name ?? a.stationId} で人身事故 — 運転見合わせ中`}
            </div>
          ))}
        </div>
      )}

      {/* ===== 下中央: 建設フィードバック + ツールバー ===== */}
      <div style={{
        position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, zIndex: 10,
      }}>
        <BuildFeedback preview={preview} toolLabel={activeTool?.label ?? ''} />

        {(buildMode === 'rail' || buildMode === 'station') && (
          <div style={panel({
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5,
          })}>
            <span style={{ color: T.textMuted }}>建設レベル</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {Array.from({ length: MAX_ELEVATED_LEVEL * 2 + 1 }, (_, i) => (i - MAX_ELEVATED_LEVEL) as BuildLevel).map(lv => (
                <button
                  key={lv}
                  onClick={() => setBuildLevel(lv)}
                  style={{
                    ...button({ active: buildLevel === lv, accent: lv < 0 ? T.accent : T.bridge, compact: true }),
                    minWidth: 30,
                  }}
                  title={
                    lv === 0 ? '地平に切替(↑/↓キーでも可)'
                    : lv > 0 ? `高架Lv${lv}に切替(↑/↓キーでも可)`
                    : `地下${-lv}に切替(↑/↓キーでも可。線路${UNDERGROUND_RAIL_COST_MULTIPLIER}倍・地下駅¥${UNDERGROUND_STATION_COST.toLocaleString()})`
                  }
                >
                  {lv === 0 ? '地平' : lv > 0 ? `Lv${lv}` : `地下${-lv}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* OpenTTD式の駅方向指定: 駅ツール選択中は軸(南北/東西)を明示選択させる。
            高架/地下駅(buildLevel!==0)は軸の概念を持たない別機構なので、地平駅
            (buildLevel===0)のときだけ出す。 */}
        {buildMode === 'station' && buildLevel === 0 && (
          <div style={panel({
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5,
          })}>
            <span style={{ color: T.textMuted }}>駅の向き</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                onClick={() => setStationAxis('ns')}
                style={{ ...button({ active: stationAxis === 'ns', accent: T.station, compact: true }), minWidth: 48 }}
                title="南北方向のホームにする"
              >
                南北
              </button>
              <button
                onClick={() => setStationAxis('ew')}
                style={{ ...button({ active: stationAxis === 'ew', accent: T.station, compact: true }), minWidth: 48 }}
                title="東西方向のホームにする"
              >
                東西
              </button>
            </div>
          </div>
        )}

        {/* S2: 信号種別の選択(信号ツール、rules.signalling==='s2'のときのみ)。 */}
        {buildMode === 'signal' && gameRules.signalling === 's2' && (
          <div style={panel({
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5,
          })}>
            <span style={{ color: T.textMuted }}>信号種別</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {SIGNAL_KIND_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setSignalKind(opt.value)}
                  style={button({ active: signalKind === opt.value, accent: T.accent, compact: true })}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* PM2: 軌間・電化の選択(線路ツール、rules.gauge=trueのときのみ)。 */}
        {buildMode === 'rail' && gameRules.gauge && (
          <div style={panel({
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5,
          })}>
            <span style={{ color: T.textMuted }}>軌間</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {[...BASIC_GAUGES, ...(gameRules.extendedGauges ? EXTENDED_GAUGES : [])].map(g => (
                <button
                  key={g.value}
                  onClick={() => setRailOptions({ ...railOptions, gauge: g.value })}
                  style={button({ active: (railOptions.gauge ?? DEFAULT_GAUGE) === g.value, accent: T.accent, compact: true })}
                >
                  {g.label}
                </button>
              ))}
            </div>
            {gameRules.electrification !== 'none' && gameRules.electrification === 'modes' && (
              <>
                <div style={{ width: 1, alignSelf: 'stretch', background: T.line, margin: '2px 0' }} />
                <button
                  onClick={() => setRailOptions({ ...railOptions, electrified: railOptions.electrified ? undefined : 'dc' })}
                  style={button({ active: !!railOptions.electrified, accent: T.station, compact: true })}
                  title={`架線設備費 +¥${RAIL_COST * 0.5}/マス`}
                >
                  {railOptions.electrified ? '電化' : '非電化'}
                </button>
              </>
            )}
            {/* PM3: boundaries以上は直流/交流を区別する三択(非電化/直流/交流)。 */}
            {gameRules.electrification !== 'none' && gameRules.electrification !== 'modes' && (
              <>
                <div style={{ width: 1, alignSelf: 'stretch', background: T.line, margin: '2px 0' }} />
                <div style={{ display: 'flex', gap: 4 }}>
                  {([
                    [undefined, '非電化'],
                    ['dc', '直流'],
                    ['ac', '交流'],
                  ] as const).map(([value, label]) => (
                    <button
                      key={label}
                      onClick={() => setRailOptions({ ...railOptions, electrified: value })}
                      style={button({
                        active: value === undefined ? !railOptions.electrified : railOptions.electrified === value,
                        accent: T.station, compact: true,
                      })}
                      title={value ? `架線設備費 +¥${RAIL_COST * 0.5}/マス` : undefined}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* 軌道(何キロレール): レール種別の選択(線路ツール、rules.trackClasses=trueのときのみ)。
            省略時は50kgN(DEFAULT_RAIL_WEIGHT)扱いなので既定選択も50kgNにしておく。 */}
        {buildMode === 'rail' && gameRules.trackClasses && (
          <div style={panel({
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5,
          })}>
            <span style={{ color: T.textMuted }}>レール種別</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {RAIL_WEIGHT_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setRailOptions({ ...railOptions, railWeight: opt.value })}
                  style={button({ active: (railOptions.railWeight ?? 50) === opt.value, accent: T.accent, compact: true })}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* S3: 保安装置の選択(線路ツール、rules.signalling==='s3'のときのみ)。 */}
        {buildMode === 'rail' && gameRules.signalling === 's3' && (
          <div style={panel({
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5,
          })}>
            <span style={{ color: T.textMuted }}>保安装置</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {PROTECTION_OPTIONS.map(opt => (
                <button
                  key={opt.label}
                  onClick={() => setRailOptions({ ...railOptions, protection: opt.value })}
                  style={button({ active: railOptions.protection === opt.value, accent: T.accent, compact: true })}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* PM2/PM3: 車庫ツールでの列車購入時の動力方式選択(rules.electrification!=='none'のみ)。
            交流/交直流はrules.electrificationが'boundaries'以上のときのみ選べる(design decision 2)。
            軌間は車庫セルの軌間を自動継承する(useGameLogic.tsのbuyTrain)ため選択させない。 */}
        {buildMode === 'depot' && gameRules.electrification !== 'none' && (
          <div style={panel({
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5,
          })}>
            <span style={{ color: T.textMuted }}>購入する動力</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {([
                ['electric', '電車'],
                ...(gameRules.electrification !== 'modes' ? [['electric-ac', '交流電車'], ['electric-acdc', '交直流電車']] as const : []),
                ['diesel', '気動車'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setPurchasePower(value)}
                  style={button({ active: purchasePower === value, accent: T.depot, compact: true })}
                  title={`¥${trainCostForProtected(value, gameRules.signalling === 's3' ? purchaseProtection : undefined).toLocaleString()}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* S3: 車庫ツールでの列車購入時の保安装置選択(rules.signalling==='s3'のときのみ)。 */}
        {buildMode === 'depot' && gameRules.signalling === 's3' && (
          <div style={panel({
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5,
          })}>
            <span style={{ color: T.textMuted }}>保安装置</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {PROTECTION_OPTIONS.map(opt => (
                <button
                  key={opt.label}
                  onClick={() => setPurchaseProtection(opt.value)}
                  style={button({ active: purchaseProtection === opt.value, accent: T.depot, compact: true })}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* PM2 Stage B: 改軌ツールの目的軌間選択(rules.gauge=trueのときのみツール自体が出る)。 */}
        {buildMode === 'regauge' && gameRules.gauge && (
          <div style={panel({
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5,
          })}>
            <span style={{ color: T.textMuted }}>改軌先</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {[...BASIC_GAUGES, ...(gameRules.extendedGauges ? EXTENDED_GAUGES : [])].map(g => (
                <button
                  key={g.value}
                  onClick={() => setRegaugeTargetGauge(g.value)}
                  style={button({ active: (regaugeTargetGauge ?? DEFAULT_GAUGE) === g.value, accent: T.bridge, compact: true })}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={panel({ display: 'flex', gap: 4, padding: 5 })}>
          {BUILD_TOOLS.filter(tool =>
            (tool.mode !== 'regauge' || gameRules.gauge) &&
            (tool.mode !== 'substation' || gameRules.electrification === 'feeding')
          ).map(tool => (
            <button
              key={tool.mode}
              onClick={() => setBuildMode(tool.mode)}
              style={{
                ...button({ active: buildMode === tool.mode, accent: tool.accent }),
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
                minWidth: 64, padding: '7px 10px',
              }}
              title={`${tool.label} (${tool.key}) — ${tool.hint}`}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                {tool.label}
                <span style={{
                  fontSize: 9, fontWeight: 700, opacity: 0.55,
                  border: '1px solid currentColor', borderRadius: 3, padding: '0 3px', lineHeight: '12px',
                }}>{tool.key}</span>
              </span>
              {tool.cost && (
                <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.75 }}>{tool.cost}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </>
  );
};

// P7d: 地上レール建設不可の具体理由(buildPreview.tsのslopeIssue、
// construction.tsのGroundRailPlanFailureReason)ごとの表示文言。
const SLOPE_ISSUE_MESSAGES: Record<NonNullable<BuildPreview['slopeIssue']>, string> = {
  'other-slope': '地形が線路に適していません(整地が必要)',
  'direction-blocked': 'この向きには勾配レールを敷けません',
  'edge-discontinuous': '地形の標高がつながっていません',
  'tunnel-exit-mismatch': 'トンネル出口の標高が合いません',
};

// 建設不可の具体理由(buildPreview.tsのfailure、construction.tsのBuildFailureReason)
// ごとの表示文言。地上レールのother-slope等(GroundRailPlanFailureReason)は
// SLOPE_ISSUE_MESSAGESと同じ文言をここにも持たせ、モードを問わず単一のマップで
// 引けるようにする(値は意図的に重複させている。表示文言の一本化はしない=
// 「slopeIssue専用の言い回し」を保つため)。
const FAILURE_MESSAGES: Record<NonNullable<BuildPreview['failure']>, string> = {
  water: '水面には建設できません',
  'not-flat': '平らな地面が必要です',
  'town-tile': '町のタイルには建設できません',
  'house-tile': '家のあるタイルは通れません',
  occupied: '他の構造物があります',
  'ramp-conflict': '坂と干渉します',
  'needs-adjacent-electrified-rail': '隣接する電化線路が必要です',
  'needs-rail': '信号は線路の上に設置します',
  'station-axis-mismatch': '線路の向きと合いません',
  'other-slope': SLOPE_ISSUE_MESSAGES['other-slope'],
  'direction-blocked': SLOPE_ISSUE_MESSAGES['direction-blocked'],
  'edge-discontinuous': SLOPE_ISSUE_MESSAGES['edge-discontinuous'],
  'tunnel-exit-mismatch': SLOPE_ISSUE_MESSAGES['tunnel-exit-mismatch'],
};

// --- 建設フィードバック(コストと可否) ---
const BuildFeedback: React.FC<{ preview: BuildPreview | null; toolLabel: string }> = ({
  preview, toolLabel,
}) => {
  if (!preview || preview.cellCount === 0) return null;

  const {
    reason, cost, cellCount, bridgeCells, tunnelCells, overpassCells, rampCells, mode, level, failure,
    terraformCorners,
  } = preview;
  // 'incomplete-path'(高架/地下の線路でまだ1マスしか指していない)は建設不可ではなく
  // 「操作の途中」なので、警告色ではなく控えめな案内にする(0.5.0-Alpha-4c)。
  const tone =
    reason === 'ok' ? T.positive
    : reason === 'insufficient-funds' ? T.danger
    : reason === 'incomplete-path' ? T.textMuted
    : T.warning;
  const message =
    reason === 'insufficient-funds' ? '資金が足りません'
    : reason === 'incomplete-path' ? 'ドラッグして2マス以上の経路を指定してください'
    : reason === 'no-effect' ? (failure ? FAILURE_MESSAGES[failure] : 'ここには建設できません')
    : null;
  const isElevatedRail = mode === 'rail' && level > 0;

  const detail: string[] = [];
  if (mode === 'rail' || mode === 'remove') detail.push(`${cellCount}マス`);
  // 地形編集は伝播で動くセルを含む課金対象セル数を出す。
  if (mode === 'raise' || mode === 'lower') detail.push(`${cellCount}マス`);
  if (bridgeCells > 0) detail.push(`橋 ${bridgeCells}`);
  if (tunnelCells > 0) detail.push(`隧道 ${tunnelCells}`);
  if (isElevatedRail) {
    if (rampCells > 0) detail.push(`坂 ${rampCells}`);
    if (overpassCells > 0) detail.push(`高架 ${overpassCells}(4倍)`);
  } else if (overpassCells > 0) {
    detail.push(`橋桁 ${overpassCells}(4倍)`);
  }
  // P-terraform: other-slope(三角形の斜面など)を自動整地(埋め立て)して建設した場合の内訳。
  if (terraformCorners) detail.push(`整地含む ${terraformCorners}`);

  return (
    <div style={panel({
      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px',
      borderColor: tone, fontSize: 12.5,
    })}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: tone, flexShrink: 0 }} />
      <span style={{ fontWeight: 700 }}>{toolLabel}</span>
      {detail.length > 0 && <span style={{ color: T.textMuted }}>{detail.join(' / ')}</span>}
      {message
        ? <span style={{ color: tone, fontWeight: 700 }}>{message}</span>
        : <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatYen(cost)}</span>}
    </div>
  );
};

// --- 列車インスペクタ ---
// 経路待ちでこの秒数以上動けていない列車は、デッドロックしている可能性が高いとみなし
// 列車インスペクタで警告する(ドラッグでの置き直しを案内する)。
const STUCK_WARNING_SECONDS = 60;

const TrainInspector: React.FC<{
  train: TrainData;
  stations: Map<string, StationData>;
  passengers: number;
  stuckSeconds: number;
  money: number;
  isEditingSchedule: boolean;
  setIsEditingSchedule: (v: boolean) => void;
  onDeploy: (id: string) => void;
  onAddCar: (id: string) => void;
  onRemoveCar: (id: string) => void;
  scheduleClipboard: string[] | null;
  onCopySchedule: (id: string) => void;
  onPasteSchedule: (id: string) => void;
  lines: LineData[];
  services: ServiceData[];
  onCreateLine: (seedTrainId?: string) => string;
  onAssignService: (trainId: string, serviceId: string | null) => void;
}> = ({
  train, stations, passengers, stuckSeconds, money, isEditingSchedule, setIsEditingSchedule,
  onDeploy, onAddCar, onRemoveCar, scheduleClipboard, onCopySchedule, onPasteSchedule,
  lines, services, onCreateLine, onAssignService,
}) => {
  const stored = train.status === 'stored';
  const assignment = resolveAssignment(train, lines, services);
  const schedule = effectiveSchedule(train, lines, services);
  const skipSet = new Set(assignment?.service.skipStationIds ?? []);
  const capacity = train.cars * CAPACITY_PER_CAR;
  const load = capacity > 0 ? passengers / capacity : 0;
  const canAdd = train.cars < 8 && money >= CAR_COST;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.accent }}>列車 {train.id}</div>
        <div style={{
          fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: T.radiusPill,
          background: stored ? 'rgba(255,255,255,0.09)' : 'rgba(52,211,153,0.16)',
          color: stored ? T.textMuted : T.positive,
        }}>
          {stored ? '車庫' : '運行中'}
        </div>
      </div>

      {!stored && stuckSeconds >= STUCK_WARNING_SECONDS && (
        <div style={{
          marginTop: 9, padding: '7px 9px', borderRadius: T.radius, fontSize: 11.5, lineHeight: 1.5,
          background: 'rgba(248,113,113,0.14)', border: `1px solid ${T.danger}`, color: T.danger,
        }}>
          立ち往生しています(約{Math.floor(stuckSeconds)}秒)。地図上でこの列車をドラッグして
          別の線路へ移すと、経路を探し直します。
        </div>
      )}

      {/* 乗車率 */}
      <div style={{ marginTop: 9 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: T.textMuted }}>
          <span>乗車</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{passengers} / {capacity}</span>
        </div>
        <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.09)', marginTop: 4, overflow: 'hidden' }}>
          <div style={{
            width: `${Math.min(100, load * 100)}%`, height: '100%',
            background: load > 0.85 ? T.warning : T.accent, transition: 'width 300ms ease',
          }} />
        </div>
      </div>

      {/* 編成 */}
      <div style={{ marginTop: 12 }}>
        <div style={sectionLabel}>編成 — {train.cars}両</div>
        <div style={{ display: 'flex', gap: 3, marginBottom: 7 }}>
          {Array.from({ length: train.cars }).map((_, i) => (
            <div key={i} title={i === 0 ? '先頭車' : `${i + 1}両目`} style={{
              flex: 1, height: 13, borderRadius: 3,
              background: i === 0 ? T.accent : 'rgba(255,255,255,0.22)',
              border: `1px solid ${T.line}`,
            }} />
          ))}
        </div>
        {stored ? (
          <div style={{ display: 'flex', gap: 5 }}>
            <button
              onClick={() => onAddCar(train.id)}
              disabled={!canAdd}
              style={{ ...button({ compact: true, disabled: !canAdd }), flex: 1 }}
            >
              ＋増結 ¥{CAR_COST.toLocaleString()}
            </button>
            <button
              onClick={() => onRemoveCar(train.id)}
              disabled={train.cars <= 1}
              style={{ ...button({ compact: true, disabled: train.cars <= 1 }), flex: 1 }}
            >
              −解結 +¥{CAR_REFUND.toLocaleString()}
            </button>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: T.textFaint }}>増解結は車庫在籍中のみ行えます</div>
        )}
      </div>

      {/* 運用(路線＋種別) */}
      <div style={{ marginTop: 13 }}>
        <div style={sectionLabel}>運用</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <button
            onClick={() => onAssignService(train.id, null)}
            style={button({ active: !assignment, compact: true })}
          >
            単独
          </button>
          {lines.map(l => (
            <button
              key={l.id}
              onClick={() => {
                const first = services.find(s => s.lineId === l.id);
                if (first) onAssignService(train.id, first.id);
              }}
              style={{
                ...button({ active: assignment?.line.id === l.id, accent: l.colour, compact: true }),
                display: 'flex', alignItems: 'center', gap: 5,
              }}
              title={`${l.name} に所属させる`}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: l.colour }} />
              {l.name}
            </button>
          ))}
          <button onClick={() => onCreateLine(train.id)} style={button({ compact: true })} title="この列車の運行表で新しい路線を作る">
            ＋新規
          </button>
        </div>
        {assignment && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 6 }}>
              {services.filter(s => s.lineId === assignment.line.id).map(s => (
                <button
                  key={s.id}
                  onClick={() => onAssignService(train.id, s.id)}
                  style={button({ active: assignment.service.id === s.id, accent: assignment.line.colour, compact: true })}
                  title={`${s.name} に所属させる`}
                >
                  {s.name}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6, lineHeight: 1.6 }}>
              {assignment.line.name} {assignment.service.name} の運行表に従う。発車間隔
              {assignment.service.headwaySeconds > 0 ? ` ${assignment.service.headwaySeconds}秒` : ' なし'}（「路線」パネルで変更）
            </div>
          </>
        )}
      </div>

      {/* 運行表 */}
      <div style={{ marginTop: 13 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={sectionLabel}>
            {assignment ? `運行表（${assignment.line.name} ${assignment.service.name}の運行表）` : '運行表'}
          </div>
          {!assignment && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              <button onClick={() => onCopySchedule(train.id)} style={button({ compact: true })} title="運行表をコピー">複製</button>
              {scheduleClipboard && (
                <button onClick={() => onPasteSchedule(train.id)} style={button({ compact: true })} title="運行表を貼り付け">貼付</button>
              )}
            </div>
          )}
        </div>

        {assignment ? (
          assignment.line.stops.length === 0 ? (
            <div style={{ fontSize: 11.5, color: T.textFaint }}>停車駅がありません</div>
          ) : (
            <div style={{ maxHeight: 108, overflowY: 'auto', fontSize: 12 }}>
              {assignment.line.stops.map((sid, idx) => {
                const skipped = skipSet.has(sid);
                const effectiveIdx = schedule.indexOf(sid);
                const isNext = !skipped && effectiveIdx === train.scheduleIndex;
                return (
                  <div key={`${sid}-${idx}`} style={{
                    display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0',
                    color: skipped ? T.textFaint : isNext ? T.text : T.textMuted,
                    fontWeight: isNext ? 700 : 400,
                    textDecoration: skipped ? 'line-through' : 'none',
                  }}>
                    <span style={{
                      width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                      background: isNext ? T.accent : 'rgba(255,255,255,0.1)',
                      color: isNext ? T.accentInk : T.textMuted,
                      fontSize: 10, fontWeight: 700, display: 'grid', placeItems: 'center',
                    }}>{idx + 1}</span>
                    {stations.get(sid)?.name ?? sid}
                  </div>
                );
              })}
            </div>
          )
        ) : schedule.length === 0 ? (
          <div style={{ fontSize: 11.5, color: T.textFaint }}>停車駅がありません</div>
        ) : (
          <div style={{ maxHeight: 108, overflowY: 'auto', fontSize: 12 }}>
            {schedule.map((sid, idx) => {
              const isNext = idx === train.scheduleIndex;
              return (
                <div key={idx} style={{
                  display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0',
                  color: isNext ? T.text : T.textMuted, fontWeight: isNext ? 700 : 400,
                }}>
                  <span style={{
                    width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                    background: isNext ? T.accent : 'rgba(255,255,255,0.1)',
                    color: isNext ? T.accentInk : T.textMuted,
                    fontSize: 10, fontWeight: 700, display: 'grid', placeItems: 'center',
                  }}>{idx + 1}</span>
                  {stations.get(sid)?.name ?? sid}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {stored && (
        <button
          onClick={() => onDeploy(train.id)}
          style={{ ...button({ active: true, accent: T.positive }), width: '100%', marginTop: 11 }}
        >
          出庫する
        </button>
      )}

      <button
        onClick={() => setIsEditingSchedule(!isEditingSchedule)}
        style={{ ...button({ active: isEditingSchedule, accent: T.station }), width: '100%', marginTop: 6 }}
      >
        {isEditingSchedule ? '運行表の編集を終える' : '運行表を編集'}
      </button>
      {isEditingSchedule && (
        <div style={{ fontSize: 11.5, color: T.station, marginTop: 6, textAlign: 'center' }}>
          {assignment
            ? `地図上の駅をクリックすると${assignment.line.name}の停車駅に追加`
            : '地図上の駅をクリックして停車駅を追加'}
        </div>
      )}
    </div>
  );
};

// --- 駅インスペクタ ---
const StationInspector: React.FC<{
  station: StationData;
  waiting: number;
  destinations: PassengerCohort[];
  arrivals: StationArrival[];
  stations: Map<string, StationData>;
  demand: number;
  money: number;
  onUpgradeDoors: (stationId: string, doorType: PlatformDoorType) => void;
}> = ({ station, waiting, destinations, arrivals, stations, demand, money, onUpgradeDoors }) => {
  const rows: [string, string][] = [
    ['待ち人数', `${waiting}人`],
    ['立地需要', `${demand.toFixed(1)}倍`],
    ['ホーム長', `${station.cells.length}マス`],
    ['ホームドア', DOOR_LABEL[station.platformDoors]],
  ];

  const upgrades: { type: PlatformDoorType; label: string; cost: number; accent: string }[] = [
    { type: 'standard', label: '標準ホームドア', cost: PLATFORM_DOOR_STANDARD_COST, accent: T.accent },
    { type: 'fullscreen', label: 'フルスクリーン', cost: PLATFORM_DOOR_FULLSCREEN_COST, accent: T.positive },
  ];

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.station }}>{station.name}</div>

      <div style={{ marginTop: 9, display: 'grid', gap: 3 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span style={{ color: T.textMuted }}>{k}</span>
            <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 13 }}>
        <div style={sectionLabel}>発車標(接近案内)</div>
        {arrivals.length === 0 ? (
          <div style={{ fontSize: 11.5, color: T.textFaint, lineHeight: 1.6 }}>
            この駅に向かっている列車はありません。
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 5, marginBottom: 4 }}>
            {arrivals.map(a => (
              <div key={a.trainId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: a.lineColour, flexShrink: 0,
                }} />
                <span style={{ color: T.textMuted, flexShrink: 0, maxWidth: 88, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.lineName}
                  {a.serviceName && (
                    <span style={{
                      marginLeft: 4, fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: T.radiusPill,
                      background: `${a.lineColour}2a`, color: a.lineColour,
                    }}>
                      {a.serviceName}
                    </span>
                  )}
                </span>
                <span style={{ flex: 1, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {(a.destinationStationId ? stations.get(a.destinationStationId)?.name : null) ?? a.trainId} ゆき
                </span>
                <span style={{ color: T.textFaint, fontSize: 11 }}>{a.cars}両</span>
                <span style={{
                  fontWeight: 700, fontVariantNumeric: 'tabular-nums', minWidth: 44, textAlign: 'right',
                  color: a.isStopped ? T.positive : T.text,
                }}>
                  {a.isStopped ? '停車中' : a.secondsUntilArrival < 10 ? 'まもなく' : `約${Math.round(a.secondsUntilArrival)}秒`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 13 }}>
        <div style={sectionLabel}>待ち客の行き先</div>
        {destinations.length === 0 ? (
          <div style={{ fontSize: 11.5, color: T.textFaint, lineHeight: 1.6 }}>
            待っている客はいません。列車が走っていない駅、どこにも行けない駅には客が集まりません。
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 3, marginBottom: 4 }}>
            {destinations.map(c => (
              <div key={c.destinationId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: T.textMuted }}>{stations.get(c.destinationId)?.name ?? c.destinationId} ゆき</span>
                <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{Math.floor(c.count)}人</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 13 }}>
        <div style={sectionLabel}>ホームドアの設置</div>
        {upgrades.map(u => {
          const already = u.type === 'standard'
            ? station.platformDoors !== 'none'
            : station.platformDoors === 'fullscreen';
          const disabled = already || money < u.cost;
          return (
            <button
              key={u.type}
              onClick={() => onUpgradeDoors(station.id, u.type)}
              disabled={disabled}
              style={{ ...button({ disabled, accent: u.accent }), width: '100%', marginBottom: 5, textAlign: 'left' }}
            >
              {u.label}
              <span style={{ float: 'right', opacity: 0.8 }}>
                {already ? '設置済' : `¥${u.cost.toLocaleString()}`}
              </span>
            </button>
          );
        })}
        <div style={{ fontSize: 11, color: T.textFaint, lineHeight: 1.6 }}>
          ホームドアを設置すると人身事故の発生確率が下がります。
        </div>
      </div>
    </div>
  );
};

// --- 借入パネル ---
// 序盤の資金切れで「線路はあるが列車が買えない」状態に陥るのを防ぐための資金繰り。
const LoanPanel: React.FC<{
  loan: number;
  money: number;
  onBorrow: (amount?: number) => void;
  onRepay: (amount?: number) => void;
}> = ({ loan, money, onBorrow, onRepay }) => {
  const canBorrow = maxAdditionalLoan(loan) > 0;
  const canRepay = loan > 0 && money > 0;
  const ratio = loan / LOAN_LIMIT;

  return (
    <div style={panel({ padding: 14, width: 220 })}>
      <div style={sectionLabel}>借入</div>
      <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: loan > 0 ? T.danger : T.text }}>
        {formatYen(loan)}
      </div>
      <div style={{ fontSize: 11, color: T.textFaint, marginTop: 2 }}>
        上限 {formatYen(LOAN_LIMIT)}・年利 {(ANNUAL_INTEREST_RATE * 100).toFixed(1)}%
      </div>
      <div style={{ height: 5, borderRadius: 3, background: T.line, marginTop: 8, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, ratio * 100)}%`, height: '100%', background: T.danger }} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button
          style={{ ...button({ compact: true, disabled: !canBorrow }), flex: 1 }}
          disabled={!canBorrow}
          onClick={() => onBorrow()}
        >
          借りる +{(LOAN_STEP / 1000).toFixed(0)}k
        </button>
        <button
          style={{ ...button({ compact: true, disabled: !canRepay }), flex: 1 }}
          disabled={!canRepay}
          onClick={() => onRepay()}
        >
          返す -{(LOAN_STEP / 1000).toFixed(0)}k
        </button>
      </div>
      <div style={{ fontSize: 10.5, color: T.textFaint, marginTop: 8, lineHeight: 1.5 }}>
        利息は月末に所持金から引かれます。返済は手持ちの範囲まで。
      </div>
    </div>
  );
};

// --- 収支パネル ---
const FinancePanel: React.FC<{ currentLedger: MonthlyLedger; ledgerHistory: MonthlyLedger[] }> = ({
  currentLedger, ledgerHistory,
}) => {
  const rows = [
    { ledger: currentLedger, label: `${currentLedger.year}年${currentLedger.month}月（進行中）`, current: true },
    ...[...ledgerHistory].reverse().map(l => ({ ledger: l, label: `${l.year}年${l.month}月`, current: false })),
  ];

  const cell: React.CSSProperties = { padding: '5px 7px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  return (
    <div style={panel({ padding: 14, width: 470, maxHeight: '58vh', overflowY: 'auto' })}>
      <div style={sectionLabel}>月次収支</div>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
        <thead>
          <tr style={{ color: T.textFaint, borderBottom: `1px solid ${T.line}` }}>
            <th style={{ ...cell, textAlign: 'left' }}>月</th>
            <th style={cell}>運賃</th>
            <th style={cell}>建設</th>
            <th style={cell}>維持</th>
            <th style={cell}>事故</th>
            <th style={cell}>利息</th>
            <th style={cell}>損益</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const l = r.ledger;
            const profit = l.fares - l.construction - l.upkeep - l.accidents - l.interest;
            return (
              <tr key={i} style={{
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                color: r.current ? T.textMuted : T.text,
              }}>
                <td style={{ ...cell, textAlign: 'left', whiteSpace: 'nowrap' }}>{r.label}</td>
                <td style={cell}>{formatYen(l.fares)}</td>
                <td style={cell}>{formatYen(l.construction)}</td>
                <td style={cell}>{formatYen(l.upkeep)}</td>
                <td style={cell}>{formatYen(l.accidents)}</td>
                <td style={cell}>{formatYen(l.interest)}</td>
                <td style={{ ...cell, fontWeight: 700, color: profit >= 0 ? T.positive : T.danger }}>
                  {formatYen(profit)}
                </td>
              </tr>
            );
          })}
          {ledgerHistory.length === 0 && (
            <tr>
              <td colSpan={7} style={{ padding: 10, textAlign: 'center', color: T.textFaint, fontStyle: 'italic' }}>
                確定済みの月次決算はまだありません
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

// --- 路線＋種別のパネル ---
const LINE_MODE_LABEL: Record<LineMode, string> = { loop: '環状', shuttle: '折返し' };

const LinePanel: React.FC<{
  lines: LineData[];
  services: ServiceData[];
  trains: TrainData[];
  stations: Map<string, StationData>;
  waitingByStation: Map<string, number>;
  /** 種別id→実績の平均運転間隔(秒)。 */
  actualIntervals: Map<string, number>;
  /** 路線id→「折返しにしたほうがよい」か。経路探索を伴うので呼び出し側でメモ化する。 */
  shuttleSuggestions: Map<string, boolean>;
  onCreateLine: (seedTrainId?: string) => string;
  onClearLineStops: (lineId: string) => void;
  onRenameLine: (lineId: string, name: string) => void;
  onSetLineMode: (lineId: string, mode: LineMode) => void;
  onDeleteLine: (lineId: string) => void;
  onCreateService: (lineId: string) => string;
  onRenameService: (serviceId: string, name: string) => void;
  onSetServiceHeadway: (serviceId: string, headwaySeconds: number) => void;
  onToggleServiceStop: (serviceId: string, stationId: string) => void;
  onDeleteService: (serviceId: string) => void;
  onAssignService: (trainId: string, serviceId: string | null) => void;
}> = ({
  lines, services, trains, stations, waitingByStation, actualIntervals, shuttleSuggestions,
  onCreateLine, onClearLineStops, onRenameLine, onSetLineMode, onDeleteLine,
  onCreateService, onRenameService, onSetServiceHeadway, onToggleServiceStop, onDeleteService, onAssignService,
}) => (
  <div style={panel({ padding: 14, width: 340, maxHeight: '72vh', overflowY: 'auto' })}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div style={sectionLabel}>路線</div>
      <button onClick={() => onCreateLine()} style={{ ...button({ compact: true }), marginBottom: 6 }}>
        ＋路線を作成
      </button>
    </div>

    {lines.length === 0 ? (
      <div style={{ fontSize: 11.5, color: T.textMuted, lineHeight: 1.7 }}>
        路線は「停車駅の並び」を決め、そこに複数の種別（各停・快速など）を作って
        列車を割り当てて運行します。同じ種別の列車は運行表を共有するので、
        1本ずつ組み直す必要がありません。
        <br />
        「＋路線を作成」で空の路線を作り、選んで駅を割り当ててください。
      </div>
    ) : (
      lines.map(l => {
        const lineServices = services.filter(s => s.lineId === l.id);
        return (
          <div key={l.id} style={{
            border: `1px solid ${T.line}`, borderRadius: T.radiusSm,
            padding: 10, marginBottom: 8, background: 'rgba(255,255,255,0.03)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: l.colour, flexShrink: 0 }} />
              <input
                value={l.name}
                onChange={e => onRenameLine(l.id, e.target.value)}
                style={{
                  flex: 1, minWidth: 0, background: 'transparent', border: 'none',
                  color: T.text, fontSize: 13, fontWeight: 700, fontFamily: T.font,
                  outline: 'none', padding: 0,
                }}
              />
              <span style={{ fontSize: 11, color: T.textMuted, whiteSpace: 'nowrap' }}>
                {lineServices.reduce((sum, s) => sum + membersOf(trains, s.id).length, 0)}本
              </span>
            </div>

            <div style={{ marginTop: 9 }}>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>運行の仕方</div>
              <div style={{ display: 'flex', gap: 3 }}>
                {(['loop', 'shuttle'] as LineMode[]).map(m => (
                  <button
                    key={m}
                    onClick={() => onSetLineMode(l.id, m)}
                    style={{ ...button({ active: (l.mode ?? 'loop') === m, accent: l.colour, compact: true }), flex: 1 }}
                    title={m === 'loop' ? '最後の駅の次は先頭の駅へ戻る' : '終端で折り返して来た道を戻る'}
                  >
                    {LINE_MODE_LABEL[m]}
                  </button>
                ))}
              </div>
              {(l.mode ?? 'loop') === 'loop' && shuttleSuggestions.get(l.id) && (
                <div style={{ fontSize: 10.5, color: T.warning, marginTop: 5, lineHeight: 1.5 }}>
                  終端から始発まで来た道を丸ごと回送しています。折返しを選ぶと無駄がなくなります。
                </div>
              )}
            </div>

            <div style={{ marginTop: 9 }}>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>停車駅</div>
              {l.stops.length === 0 ? (
                <div style={{ fontSize: 11.5, color: T.textFaint, lineHeight: 1.6 }}>
                  未設定（列車を選び「運行表を編集」で駅をクリック）
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 2 }}>
                  {l.stops.map((sid, i) => (
                    <div key={`${sid}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
                      <span style={{ color: T.textMuted }}>
                        {i + 1}. {stations.get(sid)?.name ?? sid}
                      </span>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {Math.floor(waitingByStation.get(sid) ?? 0)}人待ち
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 5, marginTop: 9 }}>
              <button
                onClick={() => onClearLineStops(l.id)}
                disabled={l.stops.length === 0}
                style={{ ...button({ compact: true, disabled: l.stops.length === 0 }), flex: 1 }}
              >
                運行表を消去
              </button>
              <button
                onClick={() => onDeleteLine(l.id)}
                style={{ ...button({ compact: true, accent: T.danger }), flex: 1 }}
                title="所属列車は運行表を引き継いで単独運用に戻ります"
              >
                路線を削除
              </button>
            </div>

            <div style={{ marginTop: 11, borderTop: `1px solid ${T.line}`, paddingTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: T.textMuted, fontWeight: 700 }}>種別</div>
                <button onClick={() => onCreateService(l.id)} style={button({ compact: true })}>
                  ＋種別を追加
                </button>
              </div>
              {lineServices.map(s => (
                <ServiceCard
                  key={s.id}
                  line={l}
                  service={s}
                  trains={trains}
                  stations={stations}
                  canDelete={lineServices.length > 1}
                  actualIntervalSeconds={actualIntervals.get(s.id) ?? null}
                  onRenameService={onRenameService}
                  onSetServiceHeadway={onSetServiceHeadway}
                  onToggleServiceStop={onToggleServiceStop}
                  onDeleteService={onDeleteService}
                  onAssignService={onAssignService}
                />
              ))}
            </div>
          </div>
        );
      })
    )}
  </div>
);

// --- 種別カード(路線パネルの入れ子) ---
const ServiceCard: React.FC<{
  line: LineData;
  service: ServiceData;
  trains: TrainData[];
  stations: Map<string, StationData>;
  canDelete: boolean;
  actualIntervalSeconds: number | null;
  onRenameService: (serviceId: string, name: string) => void;
  onSetServiceHeadway: (serviceId: string, headwaySeconds: number) => void;
  onToggleServiceStop: (serviceId: string, stationId: string) => void;
  onDeleteService: (serviceId: string) => void;
  onAssignService: (trainId: string, serviceId: string | null) => void;
}> = ({
  line, service, trains, stations, canDelete, actualIntervalSeconds,
  onRenameService, onSetServiceHeadway, onToggleServiceStop, onDeleteService, onAssignService,
}) => {
  const members = membersOf(trains, service.id);
  const skipSet = new Set(service.skipStationIds);
  const unassigned = trains.filter(t => !t.serviceId);

  return (
    <div style={{
      border: `1px solid ${T.line}`, borderRadius: T.radiusSm,
      padding: 8, marginBottom: 6, background: 'rgba(255,255,255,0.025)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          value={service.name}
          onChange={e => onRenameService(service.id, e.target.value)}
          style={{
            flex: 1, minWidth: 0, background: 'transparent', border: 'none',
            color: T.text, fontSize: 12, fontWeight: 700, fontFamily: T.font,
            outline: 'none', padding: 0,
          }}
        />
        <span style={{ fontSize: 10.5, color: T.textMuted, whiteSpace: 'nowrap' }}>{members.length}本</span>
        <button
          onClick={() => onDeleteService(service.id)}
          disabled={!canDelete}
          style={button({ compact: true, disabled: !canDelete, accent: T.danger })}
          title={canDelete ? '種別を削除' : '路線に残る最後の種別は削除できません'}
        >
          種別を削除
        </button>
      </div>

      <div style={{ marginTop: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ fontSize: 10.5, color: T.textMuted }}>発車間隔</span>
          <span style={{ fontSize: 10.5, color: T.textFaint, fontVariantNumeric: 'tabular-nums' }}>
            {actualIntervalSeconds !== null ? `実績 ${Math.round(actualIntervalSeconds)}秒` : '実績 計測中'}
          </span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {HEADWAY_CHOICES.map(sec => (
            <button
              key={sec}
              onClick={() => onSetServiceHeadway(service.id, sec)}
              style={{ ...button({ active: service.headwaySeconds === sec, accent: line.colour, compact: true }), minWidth: 36 }}
            >
              {sec === 0 ? 'なし' : `${sec}秒`}
            </button>
          ))}
        </div>
      </div>

      {line.stops.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 10.5, color: T.textMuted, marginBottom: 3 }}>停車パターン(クリックで通過切替)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {line.stops.map(sid => {
              const skipped = skipSet.has(sid);
              return (
                <button
                  key={sid}
                  onClick={() => onToggleServiceStop(service.id, sid)}
                  style={{
                    ...button({ compact: true, accent: skipped ? undefined : line.colour }),
                    opacity: skipped ? 0.5 : 1,
                    textDecoration: skipped ? 'line-through' : 'none',
                  }}
                  title={skipped ? 'クリックで停車にする' : 'クリックで通過にする'}
                >
                  {stations.get(sid)?.name ?? sid}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 10.5, color: T.textMuted, marginBottom: 3 }}>所属列車</div>
        {members.length === 0 ? (
          <div style={{ fontSize: 11, color: T.textFaint }}>まだ割り当てられていません</div>
        ) : (
          <div style={{ display: 'grid', gap: 3 }}>
            {members.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <span style={{ flex: 1, color: T.textMuted }}>
                  {t.id}（{t.cars}両・{t.status === 'running' ? '運行中' : '車庫'}）
                </span>
                <button
                  onClick={() => onAssignService(t.id, null)}
                  style={button({ compact: true })}
                  title="この種別から外す(運行表を引き継いで単独運用になります)"
                >
                  外す
                </button>
              </div>
            ))}
          </div>
        )}
        {unassigned.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 5 }}>
            {unassigned.map(t => (
              <button
                key={t.id}
                onClick={() => onAssignService(t.id, service.id)}
                style={button({ compact: true, accent: line.colour })}
                title="この種別に割り当てる"
              >
                ＋{t.id}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
