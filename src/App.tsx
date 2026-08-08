import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { useGameLogic } from './hooks/useGameLogic';
import { GameScene } from './components/GameScene';
import { GameUI } from './components/GameUI';
import type { BuildMode } from './components/GameUI';
import type { BuildLevel } from './sim/construction';
import { DEBUG_SCENARIOS } from './sim/debugScenarios';
import type { TownDensity } from './sim/towns';
import { T, button as themeButton } from './ui/theme';
import { loadRendererMode, saveRendererMode, type RendererMode } from './ui/rendererPreference';
import { WebGpuTerrainLayer } from './components/WebGpuTerrainLayer';
import type { WebGpuTerrainLayerController } from './render/webgpuLayer';
import type { WebGpuCameraState } from './render/webgpuCamera';
import { LabelOverlay, type LabelOverlayItem } from './components/LabelOverlay';
import { OVERPASS_HEIGHT } from './sim/trackPath';
import { formatPopulation } from './render/townGeometry';

// ★追加(P5): 新規ゲーム開始時のマップサイズ選択肢。halfExtentはsim/persistence.tsの
// v15セーブに含まれる値で、マップは-halfExtent..halfExtentのセル(一辺 2*halfExtent+1)。
const MAP_SIZE_OPTIONS: { label: string; halfExtent: number; side: number }[] = [
  { label: '小', halfExtent: 45, side: 91 },
  { label: '中', halfExtent: 128, side: 257 },
  { label: '大', halfExtent: 512, side: 1025 },
  { label: '特大', halfExtent: 2048, side: 4097 },
  { label: '極大', halfExtent: 8192, side: 16385 },
];

// ★追加: 新規ゲーム開始時の町密度選択肢(huge マップで町が少なすぎるという要望への対応、
// progress/16k-map-architecture.md P5追記参照)。sim/towns.tsのTownDensityと1対1。
const TOWN_DENSITY_OPTIONS: { label: string; value: TownDensity }[] = [
  { label: 'まばら', value: 'sparse' },
  { label: '標準', value: 'normal' },
  { label: '多い', value: 'dense' },
  { label: '過密', value: 'packed' },
];

export default function App() {
  const [showStartupOptions, setShowStartupOptions] = useState(true);
  // 起動ダイアログで「デバッグモード」を押すと、シナリオ一覧(sim/debugScenarios.ts)を表示する。
  const [showDebugScenarios, setShowDebugScenarios] = useState(false);
  // 起動ダイアログの町密度選択(既定は標準=normal)。マップサイズのボタンを押した時点の値を使う。
  const [selectedTownDensity, setSelectedTownDensity] = useState<TownDensity>('normal');
  const [buildMode, setBuildMode] = useState<BuildMode>('none');
  // 線路(rail)・駅(station)ツールの建設対象レベル(0=地平〜3、既定0)。GameUIのArrowUp/Down、
  // GameScene(プレビュー・commit)双方から参照するため、共通の親であるAppで保持する。
  const [buildLevel, setBuildLevel] = useState<BuildLevel>(0);
  const [simSpeed, setSimSpeed] = useState<0 | 1 | 2 | 4>(1);
  // 建設プレビュー中のセル列。GameScene(カーソル/ドラッグ)からGameUI(コスト表示)へ橋渡しする。
  const [previewPath, setPreviewPath] = useState<{ x: number; z: number }[]>([]);

  // レンダラー選択(従来 three.js / WebGPU実験版)。localStorage に永続化する。
  // WebGPUが使えない環境ではWebGpuTerrainLayerがonUnavailableで理由を返すので、
  // 従来へ自動フォールバックし、設定パネルにその理由を出す。
  const [rendererMode, setRendererMode] = useState<RendererMode>(loadRendererMode);
  const [rendererNote, setRendererNote] = useState<string | null>(null);
  const webGpuLayerRef = useRef<WebGpuTerrainLayerController | null>(null);
  const handleRendererUnavailable = useCallback((message: string) => {
    setRendererNote(message);
    setRendererMode('classic');
    saveRendererMode('classic');
  }, []);
  const changeRendererMode = useCallback((mode: RendererMode) => {
    setRendererNote(null);
    setRendererMode(mode);
    saveRendererMode(mode);
  }, []);
  const webGpuActive = rendererMode === 'webgpu';
  // R4c: WebGpuCameraSync(GameScene内)が毎フレーム書き込む最新カメラ状態。
  // Canvasの外側にあるLabelOverlay(DOMラベル)がここから読む。
  const webgpuCameraStateRef = useRef<WebGpuCameraState | null>(null);
  // R4c: 駅の待ち人数・選択列車の速度/状態はsim層(worldRef)を直接ポーリングして
  // ラベル内容へ反映する(r3fのuseFrameに乗せずに済むよう、DynamicTrain/StationLabelと
  // 同程度の低頻度(0.5秒)でだけ再計算する)。
  const [labelTick, setLabelTick] = useState(0);
  useEffect(() => {
    if (!webGpuActive) return;
    const id = window.setInterval(() => setLabelTick(t => t + 1), 500);
    return () => window.clearInterval(id);
  }, [webGpuActive]);

  // GameScene側のuseEffect依存に入るため参照を固定し、内容が変わらないときは
  // stateを更新しない(毎フレームの再レンダリングを避ける)。
  const handlePreviewChange = useCallback((path: { x: number; z: number }[]) => {
    setPreviewPath(prev => {
      if (prev.length === path.length && prev.every((p, i) => p.x === path[i].x && p.z === path[i].z)) {
        return prev;
      }
      return path;
    });
  }, []);

  const {
    railMap, stations, trains, towns, townTileIndex, newGame, field, worldSeed, halfExtent, editedField, baseField, cornerDiffs, selectedTrainId, setSelectedTrainId,
    isEditingSchedule, setIsEditingSchedule,
    commitPath, removeSignal, handleTrainArrive,
    buyTrain, deployTrain,
    addCar, removeCar,
    addSchedule, worldRef, relocateTrainAt,
    scheduleClipboard, copySchedule, pasteSchedule,
    saveGame, loadGame, loadDebugScenario,
    money, addIncome,
    loan, borrow, repay,
    selectedStationId, selectStation, upgradeStationDoors,
    activeAccidents, handleAccident,
    currentLedger, ledgerHistory, handleMonthEnd,
    handleTownGrowth,
    stopLocation, setStopLocation,
    groups, createGroup, assignTrainToGroup, setGroupHeadway, setGroupMode,
    renameGroup, clearGroupSchedule, deleteGroup,
  } = useGameLogic();

  // R4c: WebGPUモードのDOMラベルオーバーレイの中身(駅名・町名・選択列車ツールチップ)。
  // labelTickで0.5秒ごとに再計算し、worldRef.current(sim層)から待ち人数・列車速度を
  // 直接読む(StationLabel/DynamicTrainのHtml版と同じ更新頻度)。位置の高頻度更新は
  // LabelOverlay側のrAFループが担う(このuseMemoはDOM操作の対象=中身の再構築のみ)。
  const labelItems: LabelOverlayItem[] = webGpuActive ? (() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    labelTick;
    const items: LabelOverlayItem[] = [];
    const world = worldRef.current;
    for (const station of stations.values()) {
      const waiting = Math.floor(world?.waiting.get(station.id) ?? 0);
      const door = station.platformDoors === 'standard' ? '半' : station.platformDoors === 'fullscreen' ? '全' : null;
      items.push({
        key: `station-${station.id}`,
        world: { x: station.center.x, y: 1.35, z: station.center.z },
        content: (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: T.ink, color: T.text,
            border: `1px solid ${T.line}`, borderRadius: T.radiusPill,
            padding: '3px 9px', fontSize: 11, fontWeight: 600,
            boxShadow: T.shadowSm, backdropFilter: T.blur, whiteSpace: 'nowrap',
          }}>
            {station.name}
            {door && (
              <span style={{
                fontSize: 9, fontWeight: 700, color: T.accent,
                border: `1px solid ${T.accent}`, borderRadius: 3, padding: '0 3px', lineHeight: '12px',
              }}>
                {door}
              </span>
            )}
            <span style={{ color: T.textMuted, fontVariantNumeric: 'tabular-nums' }}>{waiting}人</span>
          </div>
        ),
      });
    }
    for (const town of towns) {
      items.push({
        key: `town-${town.id}`,
        world: { x: town.centre.x, y: 2.6 + field.cellHeightAt(town.centre.x, town.centre.z) * OVERPASS_HEIGHT, z: town.centre.z },
        content: (
          <div style={{
            background: 'rgba(24,30,38,0.62)', color: '#f2f5f8', padding: '2px 7px',
            borderRadius: '999px', fontSize: '10px', whiteSpace: 'nowrap',
            backdropFilter: 'blur(3px)', border: '1px solid rgba(255,255,255,0.14)',
          }}>
            <span style={{ fontWeight: 700, marginRight: 5 }}>{town.name}</span>
            {formatPopulation(town.population)}
          </div>
        ),
      });
    }
    if (selectedTrainId) {
      const runtime = world?.runtimes.get(selectedTrainId);
      const train = trains.find(t => t.id === selectedTrainId);
      if (runtime && train && train.status !== 'stored') {
        items.push({
          key: `train-${selectedTrainId}`,
          world: { x: runtime.renderPos.x, y: runtime.renderPos.y + 1.1, z: runtime.renderPos.z },
          content: (
            <div style={{
              background: 'rgba(17,22,28,0.86)', color: '#f4f7fa', padding: '5px 9px',
              borderRadius: '7px', fontSize: '11px', textAlign: 'center', width: 200,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              border: '1px solid rgba(255,255,255,0.18)', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            }}>
              <div style={{ fontWeight: 700 }}>{train.id}</div>
              <div style={{ color: '#8fe3a5', fontWeight: 'bold' }}>{Math.round(runtime.speedKmh)} km/h</div>
              <div style={{ color: '#b9c3cc' }}>{runtime.debugStatus}</div>
            </div>
          ),
        });
      }
    }
    return items;
  })() : [];

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#cfe3ef', position: 'relative', overflow: 'hidden' }}>
      {webGpuActive && (
        <WebGpuTerrainLayer
          key={`${worldSeed}:${halfExtent}`}
          seed={worldSeed}
          halfExtent={halfExtent}
          cornerDiffs={cornerDiffs}
          layerRef={webGpuLayerRef}
          onUnavailable={handleRendererUnavailable}
        />
      )}

      {/* 上層は常に three.js。WebGPUモードでは背景を透過させ、下層の地形を透かす。 */}
      <Canvas shadows gl={{ alpha: true }} style={{ position: 'absolute', inset: 0 }}>
        <GameScene
          railMap={railMap}
          stations={stations}
          trains={trains}
          towns={towns}
          townTiles={townTileIndex}
          field={field}
          halfExtent={halfExtent}
          cornerDiffs={cornerDiffs}
          webGpuLayer={webGpuActive ? webGpuLayerRef : undefined}
          webGpuCameraStateRef={webGpuActive ? webgpuCameraStateRef : undefined}
          world={worldRef}
          buildMode={buildMode}
          buildLevel={buildLevel}
          selectedTrainId={selectedTrainId}
          isEditingSchedule={isEditingSchedule}
          simSpeed={simSpeed}
          money={money}
          onCommitPath={commitPath}
          removeSignal={removeSignal}
          onSimEvent={(event) => {
            if (event.type === 'arrive') handleTrainArrive(event.trainId, event.scheduleIndex);
            if (event.type === 'income') addIncome(event.amount);
            if (event.type === 'accident') handleAccident(event);
            if (event.type === 'monthEnd') handleMonthEnd(event);
            if (event.type === 'townGrowth') handleTownGrowth(event);
          }}
          onSelectTrain={setSelectedTrainId}
          onBuyTrain={buyTrain}
          onAddSchedule={addSchedule}
          onSelectStation={selectStation}
          onPreviewChange={handlePreviewChange}
          groups={groups}
          onRelocateTrain={relocateTrainAt}
        />
      </Canvas>

      {/* R4c: WebGPUモードのDOMラベルオーバーレイ(駅名・町名・選択列車ツールチップ)。
          classicモードはGameScene内のdrei <Html>のまま(StationLabel/TownLabels/DynamicTrain)。 */}
      {webGpuActive && <LabelOverlay cameraStateRef={webgpuCameraStateRef} items={labelItems} />}

      <GameUI
        buildMode={buildMode}
        setBuildMode={setBuildMode}
        buildLevel={buildLevel}
        setBuildLevel={setBuildLevel}
        selectedTrainId={selectedTrainId}
        trains={trains}
        stations={stations}
        railMap={railMap}
        field={field}
        editedField={editedField}
        baseField={baseField}
        halfExtent={halfExtent}
        townTiles={townTileIndex}
        isEditingSchedule={isEditingSchedule}
        setIsEditingSchedule={setIsEditingSchedule}
        onDeploy={deployTrain}
        onAddCar={addCar}
        onRemoveCar={removeCar}
        scheduleClipboard={scheduleClipboard}
        onCopySchedule={copySchedule}
        onPasteSchedule={pasteSchedule}
        simSpeed={simSpeed}
        setSimSpeed={setSimSpeed}
        onSave={saveGame}
        onLoad={loadGame}
        money={money}
        world={worldRef}
        selectedStationId={selectedStationId}
        onUpgradeDoors={upgradeStationDoors}
        accidents={activeAccidents}
        currentLedger={currentLedger}
        ledgerHistory={ledgerHistory}
        loan={loan}
        onBorrow={borrow}
        onRepay={repay}
        stopLocation={stopLocation}
        onSetStopLocation={setStopLocation}
        previewPath={previewPath}
        rendererMode={rendererMode}
        onSetRendererMode={changeRendererMode}
        rendererNote={rendererNote}
        groups={groups}
        onCreateGroup={createGroup}
        onAssignGroup={assignTrainToGroup}
        onSetHeadway={setGroupHeadway}
        onSetMode={setGroupMode}
        onRenameGroup={renameGroup}
        onClearGroupSchedule={clearGroupSchedule}
        onDeleteGroup={deleteGroup}
      />

      {showStartupOptions && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(11, 17, 22, 0.48)', zIndex: 10 }}>
          <div style={{ width: 360, padding: 24, borderRadius: 14, background: '#202a33', color: '#f4f7fa', boxShadow: '0 16px 42px rgba(0,0,0,0.38)' }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>CubicTransim</div>
            {!showDebugScenarios ? (
              <>
                <p style={{ color: '#b9c3cc', lineHeight: 1.55 }}>マップサイズを選んで開始してください。</p>
                <div style={{ display: 'grid', gap: T.gap, marginBottom: T.gap }}>
                  {MAP_SIZE_OPTIONS.map(opt => (
                    <button
                      key={opt.label}
                      style={{ ...themeButton({ active: true }), width: '100%', textAlign: 'left' }}
                      onClick={() => {
                        newGame(opt.halfExtent, selectedTownDensity);
                        setShowStartupOptions(false);
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>{opt.label}</div>
                      <div style={{ fontSize: 11, fontWeight: 400, color: T.textMuted, marginTop: 2 }}>
                        {opt.side}×{opt.side}
                      </div>
                    </button>
                  ))}
                </div>
                <p style={{ color: '#b9c3cc', lineHeight: 1.55, marginTop: 0 }}>町の密度</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: T.gap, marginBottom: T.gap }}>
                  {TOWN_DENSITY_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      style={{
                        ...themeButton({ active: selectedTownDensity === opt.value, compact: true }),
                        width: '100%',
                      }}
                      onClick={() => setSelectedTownDensity(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <button
                  style={{ ...themeButton(), width: '100%' }}
                  onClick={() => setShowDebugScenarios(true)}
                >
                  デバッグモード（シナリオを選択）
                </button>
              </>
            ) : (
              <>
                <p style={{ color: '#b9c3cc', lineHeight: 1.55 }}>デバッグシナリオを選択してください。</p>
                <div style={{ display: 'grid', gap: T.gap, maxHeight: '56vh', overflowY: 'auto' }}>
                  {DEBUG_SCENARIOS.map(scenario => (
                    <button
                      key={scenario.id}
                      style={{ ...themeButton(), width: '100%', textAlign: 'left' }}
                      onClick={() => {
                        loadDebugScenario(scenario.build());
                        setSimSpeed(2);
                        setShowStartupOptions(false);
                        setShowDebugScenarios(false);
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>{scenario.label}</div>
                      <div style={{ fontSize: 11, fontWeight: 400, color: T.textMuted, marginTop: 2 }}>
                        {scenario.description}
                      </div>
                    </button>
                  ))}
                </div>
                <button
                  style={{ ...themeButton({ compact: true }), width: '100%', marginTop: T.gap }}
                  onClick={() => setShowDebugScenarios(false)}
                >
                  戻る
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
