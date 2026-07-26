import React, { useEffect, useMemo, useState } from 'react';
import type { CellData, CellType, TrainData, StationData, PlatformDoorType, TerrainType } from '../types';
import {
  RAIL_COST, STATION_COST, DEPOT_COST, SIGNAL_COST, CAPACITY_PER_CAR,
  CAR_COST, CAR_REFUND,
  PLATFORM_DOOR_STANDARD_COST, PLATFORM_DOOR_FULLSCREEN_COST,
  demandFactor, clockToDate,
} from '../sim/economy';
import type { MonthlyLedger } from '../sim/economy';
import { evaluateBuild } from '../sim/buildPreview';
import type { BuildPreview } from '../sim/buildPreview';
import type { SimWorld } from '../sim/simulation';
import type { AccidentNotice } from '../hooks/useGameLogic';
import { T, panel, button, sectionLabel, formatYen } from '../ui/theme';

// ゲーム内日付表示の更新間隔(ms)。他のポーリングと同様、低頻度で十分。
const CLOCK_POLL_INTERVAL_MS = 500;
// 選択中列車の乗客数・駅の待ち人数の更新間隔(ms)。
const POLL_INTERVAL_MS = 400;

export type BuildMode = CellType | 'none' | 'remove' | 'signal';

interface GameUIProps {
  buildMode: BuildMode;
  setBuildMode: (mode: BuildMode) => void;
  selectedTrainId: string | null;
  trains: TrainData[];
  stations: Map<string, StationData>;
  railMap: Map<string, CellData>;
  terrain: Map<string, TerrainType>;
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
  stopLocation: 'near' | 'middle' | 'far';
  onSetStopLocation: (loc: 'near' | 'middle' | 'far') => void;
  /** 建設プレビュー中のセル列(GameSceneのカーソル/ドラッグから流れてくる) */
  previewPath: { x: number; z: number }[];
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
  { mode: 'rail', label: '線路', key: '2', accent: T.accent, cost: `¥${RAIL_COST}/マス`, hint: 'ドラッグで敷設。水上は橋(5倍)、山は隧道(8倍)' },
  { mode: 'station', label: '駅', key: '3', accent: T.station, cost: `¥${STATION_COST.toLocaleString()}`, hint: '線路の上に置くと隣接セルと繋がって長いホームになる' },
  { mode: 'depot', label: '車庫', key: '4', accent: T.depot, cost: `¥${DEPOT_COST.toLocaleString()}`, hint: '車庫をクリックすると列車を購入できる' },
  { mode: 'signal', label: '信号', key: '5', accent: T.signal, cost: `¥${SIGNAL_COST.toLocaleString()}`, hint: 'Shift+クリックで撤去' },
  { mode: 'remove', label: '撤去', key: '6', accent: T.danger, cost: '無料', hint: '払い戻しはありません' },
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
  selectedTrainId, trains, stations, railMap, terrain,
  isEditingSchedule, setIsEditingSchedule,
  onDeploy, onAddCar, onRemoveCar,
  scheduleClipboard, onCopySchedule, onPasteSchedule,
  simSpeed, setSimSpeed,
  onSave, onLoad,
  money, world,
  selectedStationId, onUpgradeDoors, accidents,
  currentLedger, ledgerHistory,
  stopLocation, onSetStopLocation,
  previewPath,
}) => {
  const [gameDate, setGameDate] = useState({ year: 1, month: 1, day: 1 });
  const [openPanel, setOpenPanel] = useState<'none' | 'finance' | 'settings'>('none');
  const [passengers, setPassengers] = useState(0);
  const [stationWaiting, setStationWaiting] = useState(0);
  const [stationDemand, setStationDemand] = useState(0);

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

      if (!selectedStationId) {
        setStationWaiting(0);
        setStationDemand(0);
        return;
      }
      setStationWaiting(Math.floor(world.current?.waiting.get(selectedStationId) ?? 0));
      const station = stations.get(selectedStationId);
      setStationDemand(station ? demandFactor(station.center, world.current?.towns ?? []) : 0);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [selectedTrainId, selectedStationId, world, stations]);

  // キーボードショートカット: 1〜6で建設モード、Spaceで一時停止、Escで選択解除。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const tool = BUILD_TOOLS.find(t => t.key === e.key);
      if (tool) { setBuildMode(tool.mode); return; }
      if (e.code === 'Space') { e.preventDefault(); setSimSpeed(simSpeed === 0 ? 1 : 0); return; }
      if (e.key === 'Escape') { setBuildMode('none'); setOpenPanel('none'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setBuildMode, setSimSpeed, simSpeed]);

  const selectedTrain = trains.find(t => t.id === selectedTrainId);
  const selectedStation = selectedStationId ? stations.get(selectedStationId) : undefined;
  const activeTool = BUILD_TOOLS.find(t => t.mode === buildMode);

  // 建設プレビュー(コスト・可否)。建設ロジックそのものに問い合わせて判定する。
  const preview = useMemo(() => {
    if (buildMode === 'none' || previewPath.length === 0) return null;
    return evaluateBuild(buildMode, previewPath, railMap, stations, terrain, money);
  }, [buildMode, previewPath, railMap, stations, terrain, money]);

  const monthProfit =
    currentLedger.fares - currentLedger.construction - currentLedger.upkeep - currentLedger.accidents;

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
        </div>

        <div style={{ padding: '11px 14px 13px' }}>
          {selectedTrain ? (
            <TrainInspector
              train={selectedTrain}
              stations={stations}
              passengers={passengers}
              money={money}
              isEditingSchedule={isEditingSchedule}
              setIsEditingSchedule={setIsEditingSchedule}
              onDeploy={onDeploy}
              onAddCar={onAddCar}
              onRemoveCar={onRemoveCar}
              scheduleClipboard={scheduleClipboard}
              onCopySchedule={onCopySchedule}
              onPasteSchedule={onPasteSchedule}
            />
          ) : selectedStation ? (
            <StationInspector
              station={selectedStation}
              waiting={stationWaiting}
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

        {openPanel === 'finance' && (
          <FinancePanel currentLedger={currentLedger} ledgerHistory={ledgerHistory} />
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

// --- 建設フィードバック(コストと可否) ---
const BuildFeedback: React.FC<{ preview: BuildPreview | null; toolLabel: string }> = ({
  preview, toolLabel,
}) => {
  if (!preview || preview.cellCount === 0) return null;

  const { reason, cost, cellCount, bridgeCells, tunnelCells, mode } = preview;
  const tone = reason === 'ok' ? T.positive : reason === 'insufficient-funds' ? T.danger : T.warning;
  const message =
    reason === 'insufficient-funds' ? '資金が足りません'
    : reason === 'no-effect' ? 'ここには建設できません'
    : null;

  const detail: string[] = [];
  if (mode === 'rail' || mode === 'remove') detail.push(`${cellCount}マス`);
  if (bridgeCells > 0) detail.push(`橋 ${bridgeCells}`);
  if (tunnelCells > 0) detail.push(`隧道 ${tunnelCells}`);

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
const TrainInspector: React.FC<{
  train: TrainData;
  stations: Map<string, StationData>;
  passengers: number;
  money: number;
  isEditingSchedule: boolean;
  setIsEditingSchedule: (v: boolean) => void;
  onDeploy: (id: string) => void;
  onAddCar: (id: string) => void;
  onRemoveCar: (id: string) => void;
  scheduleClipboard: string[] | null;
  onCopySchedule: (id: string) => void;
  onPasteSchedule: (id: string) => void;
}> = ({
  train, stations, passengers, money, isEditingSchedule, setIsEditingSchedule,
  onDeploy, onAddCar, onRemoveCar, scheduleClipboard, onCopySchedule, onPasteSchedule,
}) => {
  const stored = train.status === 'stored';
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

      {/* 運行表 */}
      <div style={{ marginTop: 13 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={sectionLabel}>運行表</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            <button onClick={() => onCopySchedule(train.id)} style={button({ compact: true })} title="運行表をコピー">複製</button>
            {scheduleClipboard && (
              <button onClick={() => onPasteSchedule(train.id)} style={button({ compact: true })} title="運行表を貼り付け">貼付</button>
            )}
          </div>
        </div>

        {train.schedule.length === 0 ? (
          <div style={{ fontSize: 11.5, color: T.textFaint }}>停車駅がありません</div>
        ) : (
          <div style={{ maxHeight: 108, overflowY: 'auto', fontSize: 12 }}>
            {train.schedule.map((sid, idx) => {
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
  demand: number;
  money: number;
  onUpgradeDoors: (stationId: string, doorType: PlatformDoorType) => void;
}> = ({ station, waiting, demand, money, onUpgradeDoors }) => {
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
            <th style={cell}>損益</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const l = r.ledger;
            const profit = l.fares - l.construction - l.upkeep - l.accidents;
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
                <td style={{ ...cell, fontWeight: 700, color: profit >= 0 ? T.positive : T.danger }}>
                  {formatYen(profit)}
                </td>
              </tr>
            );
          })}
          {ledgerHistory.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: 10, textAlign: 'center', color: T.textFaint, fontStyle: 'italic' }}>
                確定済みの月次決算はまだありません
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};
