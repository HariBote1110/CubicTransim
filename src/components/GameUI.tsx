import React, { useEffect, useMemo, useState } from 'react';
import type { CellData, CellType, TrainData, TrainGroupData, StationData, PlatformDoorType } from '../types';
import {
  RAIL_COST, STATION_COST, DEPOT_COST, SIGNAL_COST, TERRAIN_EDIT_COST, CAPACITY_PER_CAR,
  CAR_COST, CAR_REFUND,
  PLATFORM_DOOR_STANDARD_COST, PLATFORM_DOOR_FULLSCREEN_COST,
  demandFactor, clockToDate,
} from '../sim/economy';
import type { MonthlyLedger } from '../sim/economy';
import { ANNUAL_INTEREST_RATE, LOAN_LIMIT, LOAN_STEP, maxAdditionalLoan, monthlyInterest } from '../sim/loans';
import type { PassengerCohort } from '../sim/passengers';
import { evaluateBuild } from '../sim/buildPreview';
import type { TownTileIndex } from '../sim/townTiles';
import { effectiveSchedule, findGroup, membersOf, HEADWAY_CHOICES, averageInterval, suggestsShuttle } from '../sim/groups';
import type { LineMode } from '../sim/groups';
import type { BuildPreview } from '../sim/buildPreview';
import type { SimWorld } from '../sim/simulation';
import { computeStationArrivals } from '../sim/arrivals';
import type { StationArrival } from '../sim/arrivals';
import type { AccidentNotice } from '../hooks/useGameLogic';
import { T, panel, button, sectionLabel, formatYen } from '../ui/theme';
import type { RendererMode } from '../ui/rendererPreference';
import { MAX_ELEVATED_LEVEL, stepElevatedLevel } from '../sim/trackPath';
import type { BuildLevel } from '../sim/construction';
import { UNDERGROUND_RAIL_COST_MULTIPLIER, UNDERGROUND_STATION_COST } from '../sim/economy';
import type { TerrainField } from '../sim/terrainField';
import type { EditedTerrainField } from '../sim/terrainOverlay';
import { buildEditBlockers } from '../sim/terrainOverlay';

// ゲーム内日付表示の更新間隔(ms)。他のポーリングと同様、低頻度で十分。
const CLOCK_POLL_INTERVAL_MS = 500;
// 選択中列車の乗客数・駅の待ち人数の更新間隔(ms)。
const POLL_INTERVAL_MS = 400;

export type BuildMode = CellType | 'none' | 'remove' | 'signal' | 'raise' | 'lower';

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
  /** レンダラー選択(従来 three.js / WebGPU実験版)。設定パネルで切り替える。 */
  rendererMode: RendererMode;
  onSetRendererMode: (mode: RendererMode) => void;
  /** WebGPUが使えず従来へ自動フォールバックしたときの理由文。 */
  rendererNote: string | null;
  // ★追加: 運用グループ(共有運行表＋発車間隔)
  groups: TrainGroupData[];
  onCreateGroup: (seedTrainId?: string) => string;
  onAssignGroup: (trainId: string, groupId: string | null) => void;
  onSetHeadway: (groupId: string, headwaySeconds: number) => void;
  onSetMode: (groupId: string, mode: LineMode) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onClearGroupSchedule: (groupId: string) => void;
  onDeleteGroup: (groupId: string) => void;
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

// 設定パネルのレンダラー選択。
const RENDERER_OPTIONS: { value: RendererMode; label: string }[] = [
  { value: 'classic', label: '従来' },
  { value: 'webgpu', label: 'WebGPU実験版' },
];

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
  rendererMode,
  onSetRendererMode,
  rendererNote,
  groups, onCreateGroup, onAssignGroup, onSetHeadway, onSetMode, onRenameGroup,
  onClearGroupSchedule, onDeleteGroup,
}) => {
  const [gameDate, setGameDate] = useState({ year: 1, month: 1, day: 1 });
  const [openPanel, setOpenPanel] = useState<'none' | 'finance' | 'settings' | 'groups'>('none');
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
  // 路線id→実績の平均運転間隔(秒)。設定値どおりに走れているかを見るため。
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
      const samples = world.current?.groupIntervals;
      setActualIntervals(new Map(
        samples
          ? groups.map(g => [g.id, averageInterval(samples, g.id)] as const)
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
          ? computeStationArrivals(selectedStationId, world.current.trains, world.current.runtimes, groups)
          : []
      );
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [selectedTrainId, selectedStationId, world, stations, groups]);

  // キーボードショートカット: 1〜6で建設モード、Spaceで一時停止、Escで選択解除。
  // 線路(rail)・駅(station)ツール選択中はArrowUp/Downで建設レベルを0(地平)〜
  // MAX_ELEVATED_LEVELまで±1する(状態遷移そのものはsim/trackPath.tsのstepElevatedLevelに委譲)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const tool = BUILD_TOOLS.find(t => t.key === e.key);
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
  }, [setBuildMode, setSimSpeed, simSpeed, buildMode, buildLevel, setBuildLevel]);

  const selectedTrain = trains.find(t => t.id === selectedTrainId);
  const selectedStation = selectedStationId ? stations.get(selectedStationId) : undefined;
  const activeTool = BUILD_TOOLS.find(t => t.mode === buildMode);

  // 建設プレビュー(コスト・可否)。建設ロジックそのものに問い合わせて判定する。
  const preview = useMemo(() => {
    if (buildMode === 'none' || previewPath.length === 0) return null;
    const blockers = buildEditBlockers({ halfExtent, railMap, townTileIndex: townTiles, baseField });
    return evaluateBuild(buildMode, previewPath, railMap, stations, field, money, buildLevel, townTiles, {
      base: baseField, editedField, blockers,
    });
  }, [buildMode, previewPath, railMap, stations, field, baseField, editedField, money, buildLevel, townTiles, halfExtent]);

  // 折返し推奨の判定は経路探索を伴うので、路線・線路・駅が変わったときだけ計算する。
  const shuttleSuggestions = useMemo(
    () => new Map(groups.map(g => [g.id, suggestsShuttle(g.schedule, railMap, stations)])),
    [groups, railMap, stations]
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
              groups={groups}
              onCreateGroup={onCreateGroup}
              onAssignGroup={onAssignGroup}
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
            onClick={() => setOpenPanel(p => (p === 'groups' ? 'none' : 'groups'))}
            style={button({ active: openPanel === 'groups', accent: T.station, compact: true })}
          >
            運用
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

            <div style={{ height: 1, background: T.line, margin: '14px 0' }} />

            <div style={sectionLabel}>レンダラー</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {RENDERER_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => onSetRendererMode(opt.value)}
                  style={{ ...button({ active: rendererMode === opt.value, compact: true }), flex: 1 }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 8, lineHeight: 1.6 }}>
              WebGPU実験版は地形だけを新しいレンダラー(Rust + wgpu)で描きます。
              地形編集(盛土/切土)の結果も反映されますが、地形に影はまだ落ちません。
              非対応の環境では自動で従来に戻ります。
            </div>
            {rendererNote && (
              <div style={{ fontSize: 11, color: T.warning, marginTop: 6, lineHeight: 1.6 }}>
                {rendererNote}
              </div>
            )}
          </div>
        )}

        {openPanel === 'groups' && (
          <GroupPanel
            groups={groups}
            trains={trains}
            stations={stations}
            waitingByStation={waitingByStation}
            actualIntervals={actualIntervals}
            shuttleSuggestions={shuttleSuggestions}
            onCreateGroup={onCreateGroup}
            onAssignGroup={onAssignGroup}
            onSetHeadway={onSetHeadway}
            onSetMode={onSetMode}
            onRenameGroup={onRenameGroup}
            onClearGroupSchedule={onClearGroupSchedule}
            onDeleteGroup={onDeleteGroup}
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
              ⚠ {stations.get(a.stationId)?.name ?? a.stationId} で人身事故 — 運転見合わせ中
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

        <div style={panel({ display: 'flex', gap: 4, padding: 5 })}>
          {BUILD_TOOLS.map(tool => (
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

// --- 建設フィードバック(コストと可否) ---
const BuildFeedback: React.FC<{ preview: BuildPreview | null; toolLabel: string }> = ({
  preview, toolLabel,
}) => {
  if (!preview || preview.cellCount === 0) return null;

  const { reason, cost, cellCount, bridgeCells, tunnelCells, overpassCells, rampCells, mode, level, slopeIssue } = preview;
  const tone = reason === 'ok' ? T.positive : reason === 'insufficient-funds' ? T.danger : T.warning;
  const message =
    reason === 'insufficient-funds' ? '資金が足りません'
    : reason === 'no-effect' ? (slopeIssue ? SLOPE_ISSUE_MESSAGES[slopeIssue] : 'ここには建設できません')
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
  groups: TrainGroupData[];
  onCreateGroup: (seedTrainId?: string) => string;
  onAssignGroup: (trainId: string, groupId: string | null) => void;
}> = ({
  train, stations, passengers, stuckSeconds, money, isEditingSchedule, setIsEditingSchedule,
  onDeploy, onAddCar, onRemoveCar, scheduleClipboard, onCopySchedule, onPasteSchedule,
  groups, onCreateGroup, onAssignGroup,
}) => {
  const stored = train.status === 'stored';
  const group = findGroup(groups, train.groupId);
  const schedule = effectiveSchedule(train, groups);
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

      {/* 運用グループ */}
      <div style={{ marginTop: 13 }}>
        <div style={sectionLabel}>運用</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <button
            onClick={() => onAssignGroup(train.id, null)}
            style={button({ active: !group, compact: true })}
          >
            単独
          </button>
          {groups.map(g => (
            <button
              key={g.id}
              onClick={() => onAssignGroup(train.id, g.id)}
              style={{
                ...button({ active: group?.id === g.id, accent: g.colour, compact: true }),
                display: 'flex', alignItems: 'center', gap: 5,
              }}
              title={`${g.name} に所属させる`}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: g.colour }} />
              {g.name}
            </button>
          ))}
          <button onClick={() => onCreateGroup(train.id)} style={button({ compact: true })} title="この列車の運行表で新しいグループを作る">
            ＋新規
          </button>
        </div>
        {group && (
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6, lineHeight: 1.6 }}>
            {group.name} の運行表を共有中。発車間隔
            {group.headwaySeconds > 0 ? ` ${group.headwaySeconds}秒` : ' なし'}（「運用」パネルで変更）
          </div>
        )}
      </div>

      {/* 運行表 */}
      <div style={{ marginTop: 13 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={sectionLabel}>{group ? `運行表（${group.name}で共有）` : '運行表'}</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            <button onClick={() => onCopySchedule(train.id)} style={button({ compact: true })} title="運行表をコピー">複製</button>
            {scheduleClipboard && (
              <button onClick={() => onPasteSchedule(train.id)} style={button({ compact: true })} title="運行表を貼り付け">貼付</button>
            )}
          </div>
        </div>

        {schedule.length === 0 ? (
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
          地図上の駅をクリックして停車駅を追加
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
                <span style={{ color: T.textMuted, flexShrink: 0, maxWidth: 64, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.lineName}
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

// --- 運用グループのパネル ---
const LINE_MODE_LABEL: Record<LineMode, string> = { loop: '環状', shuttle: '折返し' };

const GroupPanel: React.FC<{
  groups: TrainGroupData[];
  trains: TrainData[];
  stations: Map<string, StationData>;
  waitingByStation: Map<string, number>;
  actualIntervals: Map<string, number>;
  /** 路線id→「折返しにしたほうがよい」か。経路探索を伴うので呼び出し側でメモ化する。 */
  shuttleSuggestions: Map<string, boolean>;
  onCreateGroup: (seedTrainId?: string) => string;
  onAssignGroup: (trainId: string, groupId: string | null) => void;
  onSetHeadway: (groupId: string, headwaySeconds: number) => void;
  onSetMode: (groupId: string, mode: LineMode) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onClearGroupSchedule: (groupId: string) => void;
  onDeleteGroup: (groupId: string) => void;
}> = ({
  groups, trains, stations, waitingByStation, actualIntervals, shuttleSuggestions,
  onCreateGroup, onAssignGroup, onSetHeadway, onSetMode, onRenameGroup, onClearGroupSchedule, onDeleteGroup,
}) => (
  <div style={panel({ padding: 14, width: 330, maxHeight: '64vh', overflowY: 'auto' })}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div style={sectionLabel}>路線</div>
      <button onClick={() => onCreateGroup()} style={{ ...button({ compact: true }), marginBottom: 6 }}>
        ＋新規
      </button>
    </div>

    {groups.length === 0 ? (
      <div style={{ fontSize: 11.5, color: T.textMuted, lineHeight: 1.7 }}>
        路線は「停車駅の並び」と「発車間隔」を決め、そこに列車を割り当てて運行します。
        同じ路線の列車は運行表を共有するので、1本ずつ組み直す必要がありません。
        <br />
        列車を選んで「運用」から作成してください。
      </div>
    ) : (
      groups.map(g => {
        const members = membersOf(trains, g.id);
        return (
          <div key={g.id} style={{
            border: `1px solid ${T.line}`, borderRadius: T.radiusSm,
            padding: 10, marginBottom: 8, background: 'rgba(255,255,255,0.03)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: g.colour, flexShrink: 0 }} />
              <input
                value={g.name}
                onChange={e => onRenameGroup(g.id, e.target.value)}
                style={{
                  flex: 1, minWidth: 0, background: 'transparent', border: 'none',
                  color: T.text, fontSize: 13, fontWeight: 700, fontFamily: T.font,
                  outline: 'none', padding: 0,
                }}
              />
              <span style={{ fontSize: 11, color: T.textMuted, whiteSpace: 'nowrap' }}>
                {members.length}本
              </span>
            </div>

            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: T.textMuted }}>発車間隔</span>
                <span style={{ fontSize: 11, color: T.textFaint, fontVariantNumeric: 'tabular-nums' }}>
                  {actualIntervals.has(g.id)
                    ? `実績 ${Math.round(actualIntervals.get(g.id)!)}秒`
                    : '実績 計測中'}
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {HEADWAY_CHOICES.map(sec => (
                  <button
                    key={sec}
                    onClick={() => onSetHeadway(g.id, sec)}
                    style={{ ...button({ active: g.headwaySeconds === sec, accent: g.colour, compact: true }), minWidth: 40 }}
                  >
                    {sec === 0 ? 'なし' : `${sec}秒`}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 9 }}>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>運行の仕方</div>
              <div style={{ display: 'flex', gap: 3 }}>
                {(['loop', 'shuttle'] as LineMode[]).map(m => (
                  <button
                    key={m}
                    onClick={() => onSetMode(g.id, m)}
                    style={{ ...button({ active: (g.mode ?? 'loop') === m, accent: g.colour, compact: true }), flex: 1 }}
                    title={m === 'loop' ? '最後の駅の次は先頭の駅へ戻る' : '終端で折り返して来た道を戻る'}
                  >
                    {LINE_MODE_LABEL[m]}
                  </button>
                ))}
              </div>
              {(g.mode ?? 'loop') === 'loop' && shuttleSuggestions.get(g.id) && (
                <div style={{ fontSize: 10.5, color: T.warning, marginTop: 5, lineHeight: 1.5 }}>
                  終端から始発まで来た道を丸ごと回送しています。折返しを選ぶと無駄がなくなります。
                </div>
              )}
            </div>

            <div style={{ marginTop: 9 }}>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>停車駅</div>
              {g.schedule.length === 0 ? (
                <div style={{ fontSize: 11.5, color: T.textFaint, lineHeight: 1.6 }}>
                  未設定（列車を選び「運行表を編集」で駅をクリック）
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 2 }}>
                  {g.schedule.map((sid, i) => (
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

            <div style={{ marginTop: 9 }}>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>所属列車</div>
              {members.length === 0 ? (
                <div style={{ fontSize: 11.5, color: T.textFaint }}>まだ割り当てられていません</div>
              ) : (
                <div style={{ display: 'grid', gap: 3 }}>
                  {members.map(t => (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
                      <span style={{ flex: 1, color: T.textMuted }}>
                        {t.id}（{t.cars}両・{t.status === 'running' ? '運行中' : '車庫'}）
                      </span>
                      <button
                        onClick={() => onAssignGroup(t.id, null)}
                        style={button({ compact: true })}
                        title="この路線から外す(運行表を引き継いで単独運用になります)"
                      >
                        外す
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {trains.filter(t => !t.groupId).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 5 }}>
                  {trains.filter(t => !t.groupId).map(t => (
                    <button
                      key={t.id}
                      onClick={() => onAssignGroup(t.id, g.id)}
                      style={button({ compact: true, accent: g.colour })}
                      title="この路線に割り当てる"
                    >
                      ＋{t.id}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 5, marginTop: 9 }}>
              <button
                onClick={() => onClearGroupSchedule(g.id)}
                disabled={g.schedule.length === 0}
                style={{ ...button({ compact: true, disabled: g.schedule.length === 0 }), flex: 1 }}
              >
                運行表を消去
              </button>
              <button
                onClick={() => onDeleteGroup(g.id)}
                style={{ ...button({ compact: true, accent: T.danger }), flex: 1 }}
                title="所属列車は運行表を引き継いで単独運用に戻ります"
              >
                路線を削除
              </button>
            </div>
          </div>
        );
      })
    )}
  </div>
);
