import { useCallback, useEffect, useRef, useState } from 'react';
import { useGameLogic } from './hooks/useGameLogic';
import { GameScene } from './components/GameScene';
import { GameUI } from './components/GameUI';
import type { BuildMode } from './components/GameUI';
import type { BuildLevel, StationAxis } from './sim/construction';
import { DEBUG_SCENARIOS } from './sim/debugScenarios';
import type { TownDensity } from './sim/towns';
import type { TerrainProfile } from './sim/terrainField';
import { PLAY_MODE_PRESETS, PLAY_MODE_LABELS, effectiveRailOptions, type PlayMode, type Signalling } from './sim/gameRules';
import type { RailBuildOptions } from './sim/construction';
import type { RailGauge, TrainPower, SignalKind, TrainProtection } from './types';
import { DEFAULT_GAUGE } from './types';
import { T, button as themeButton } from './ui/theme';
import { WebGpuTerrainLayer } from './components/WebGpuTerrainLayer';
import type { WebGpuTerrainLayerController, WebGpuUnavailableReason } from './render/webgpuLayer';
import type { WebGpuCameraState } from './render/webgpuCamera';
import {
  createCameraState, type GameCameraState, type ViewportSize,
} from './render/cameraState';
import { frameLoop } from './render/frameLoop';

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

// 新規ゲーム開始時の地形プロファイル選択肢(progress/terrain-profiles.md)。
// sim/terrainField.ts の TerrainProfile と1対1で、標高しきい値テーブルだけが変わる。
const TERRAIN_PROFILE_OPTIONS: { label: string; value: TerrainProfile; hint: string }[] = [
  { label: '平坦', value: 'flat', hint: '広い平野' },
  { label: '標準', value: 'normal', hint: 'ほどよい丘' },
  { label: '山がち', value: 'mountain', hint: '起伏だらけ' },
];

// 新規ゲーム開始時のプレイモード選択肢(progress/play-modes-plan.md PM1)。
// PLAY_MODE_PRESETSと1対1で、選ぶとそのプリセットのGameRulesがそのまま新ゲームへ渡る。
const PLAY_MODE_HINTS: Record<PlayMode, string> = {
  light: '軌間・電化の概念なし(現行仕様)',
  normal: '軌間の選択、直流電化の選択',
  advanced: 'ノーマル+交直流の扱い',
  realistic: '電化まわり全部盛り',
};
const PLAY_MODE_OPTIONS: { label: string; value: PlayMode; hint: string }[] = (
  Object.keys(PLAY_MODE_PRESETS) as PlayMode[]
).map(mode => ({ label: PLAY_MODE_LABELS[mode], value: mode, hint: PLAY_MODE_HINTS[mode] }));

// 信号方式の選択肢(progress/signalling-plan.md)。プレイモードとは独立した別軸。
const SIGNALLING_OPTIONS: { label: string; value: Signalling; hint: string }[] = [
  { label: 'おまかせ', value: 's0', hint: '信号機の設置は不要。移動閉塞で自動的に間隔が詰まる(既定)' },
  { label: '固定閉塞', value: 's1', hint: '信号機で区切った区間だけが閉塞になる。単線行き違いを自分で設計する' },
  { label: '信号種別', value: 's2', hint: '信号に場内・出発・閉塞の役割がつく。駅構内配線の設計が意味を持つ' },
  { label: '保安装置', value: 's3', hint: 'ATS-S/ATS-P/ATC/CBTCを敷設する。上位装置ほど信号冒進を確実に防げる。CBTCは移動閉塞を投資で取り戻す' },
];

/**
 * R4d: WebGPU が使えないときの案内画面。three.js のフォールバックは廃止したので、
 * ここから先へは進めない(理由ごとに次の一手を日本語で示す)。
 */
const UNAVAILABLE_GUIDANCE: Record<WebGpuUnavailableReason, { title: string; body: string[] }> = {
  'no-webgpu': {
    title: 'WebGPU に対応した環境が必要です',
    body: [
      'CubicTransim の描画は WebGPU 専用です。この環境では WebGPU が有効になっていません。',
      'Chrome / Edge / Electron の最新版でお試しください（Safari は現時点では未対応の場合があります）。',
      'ブラウザが最新でも表示されない場合は、GPU アクセラレーションが無効になっていないか設定を確認してください。',
    ],
  },
  'asset-missing': {
    title: 'WebGPU レンダラーがビルドされていません',
    body: [
      'wasm レンダラー（public/renderer/）が見つかりません。開発環境では次のコマンドでビルドしてください。',
      'npm run build:renderer',
      'ビルド後にページを再読み込みすると起動します。',
    ],
  },
  'init-failed': {
    title: 'WebGPU レンダラーの初期化に失敗しました',
    body: [
      'アダプタの取得またはデバイスの生成に失敗しました。',
      'ブラウザを再起動するか、GPU ドライバを更新してからお試しください。',
      '詳細な原因は開発者コンソールのログに出力されています。',
    ],
  },
};

const UnavailableScreen: React.FC<{ reason: WebGpuUnavailableReason }> = ({ reason }) => {
  const guidance = UNAVAILABLE_GUIDANCE[reason];
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
      background: '#0b1116', color: '#f4f7fa', zIndex: 100, padding: 24,
    }}>
      <div style={{ maxWidth: 560 }}>
        <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>{guidance.title}</div>
        {guidance.body.map((line, i) => (
          <p key={i} style={{
            color: '#b9c3cc', lineHeight: 1.7,
            fontFamily: line.startsWith('npm ') ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
            background: line.startsWith('npm ') ? '#1a232c' : undefined,
            padding: line.startsWith('npm ') ? '8px 12px' : undefined,
            borderRadius: line.startsWith('npm ') ? 6 : undefined,
          }}>
            {line}
          </p>
        ))}
      </div>
    </div>
  );
};

export default function App() {
  const [showStartupOptions, setShowStartupOptions] = useState(true);
  // 起動ダイアログで「デバッグモード」を押すと、シナリオ一覧(sim/debugScenarios.ts)を表示する。
  const [showDebugScenarios, setShowDebugScenarios] = useState(false);
  // 起動ダイアログの町密度選択(既定は標準=normal)。マップサイズのボタンを押した時点の値を使う。
  const [selectedTownDensity, setSelectedTownDensity] = useState<TownDensity>('normal');
  // 起動ダイアログの地形選択(既定は標準=normal)。マップサイズのボタンを押した時点の値を使う。
  const [selectedTerrainProfile, setSelectedTerrainProfile] = useState<TerrainProfile>('normal');
  const [selectedPlayMode, setSelectedPlayMode] = useState<PlayMode>('light');
  const [selectedSignalling, setSelectedSignalling] = useState<Signalling>('s0');
  const [buildMode, setBuildMode] = useState<BuildMode>('none');
  // 線路(rail)・駅(station)ツールの建設対象レベル(0=地平〜3、既定0)。GameUIのArrowUp/Down、
  // GameScene(プレビュー・commit)双方から参照するため、共通の親であるAppで保持する。
  const [buildLevel, setBuildLevel] = useState<BuildLevel>(0);
  // OpenTTD式の駅方向指定: 駅(station)ツールでプレイヤーが選ぶ軸。GameUIのトグル、
  // GameScene(プレビュー・commit)双方から参照するため、共通の親であるAppで保持する。
  const [stationAxis, setStationAxis] = useState<StationAxis>('ew');
  // PM2: 線路ツールの軌間/電化選択、改軌ツールの目的軌間、車庫での購入動力。
  // いずれもrules.gauge=false(ライト)の間はUIから触れられないため既定値のまま使われない。
  const [railOptions, setRailOptions] = useState<RailBuildOptions>({ gauge: DEFAULT_GAUGE });
  const [regaugeTargetGauge, setRegaugeTargetGauge] = useState<RailGauge | undefined>(DEFAULT_GAUGE);
  // S2: 信号ツールで置く信号の種別選択。rules.signalling!=='s2'の間はUIから触れられない。
  const [signalKind, setSignalKind] = useState<SignalKind>('block');
  const [purchasePower, setPurchasePower] = useState<TrainPower>('diesel');
  const [purchaseProtection, setPurchaseProtection] = useState<TrainProtection | undefined>(undefined);
  const [simSpeed, setSimSpeed] = useState<0 | 1 | 2 | 4>(1);
  // 建設プレビュー中のセル列。GameScene(カーソル/ドラッグ)からGameUI(コスト表示)へ橋渡しする。
  const [previewPath, setPreviewPath] = useState<{ x: number; z: number }[]>([]);

  const webGpuLayerRef = useRef<WebGpuTerrainLayerController | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<WebGpuUnavailableReason | null>(null);
  const handleRendererUnavailable = useCallback((reason: WebGpuUnavailableReason) => {
    setUnavailableReason(reason);
  }, []);
  const handleRendererReady = useCallback(() => setUnavailableReason(null), []);

  // R4d: カメラの真実源(render/cameraState.ts)。GameScene の入力レイヤーが書き換え、
  // 共有 rAF ループの render フェーズで wgpu へ push される。
  const cameraRef = useRef<GameCameraState>(createCameraState());
  const viewportRef = useRef<ViewportSize>({
    cssWidth: window.innerWidth,
    cssHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  });
  // ビューポートの変化は minZoom などの派生値に効くので state にも反映する(頻度は低い)。
  const [, setViewportTick] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  // 直近フレームのカメラ状態(DOMラベルオーバーレイが読む)。
  const webgpuCameraStateRef = useRef<WebGpuCameraState | null>(null);

  useEffect(() => {
    const element = rootRef.current;
    const apply = () => {
      const rect = element?.getBoundingClientRect();
      viewportRef.current = {
        cssWidth: Math.max(1, rect?.width ?? window.innerWidth),
        cssHeight: Math.max(1, rect?.height ?? window.innerHeight),
        dpr: window.devicePixelRatio || 1,
      };
      setViewportTick(t => t + 1);
    };
    apply();
    const observer = new ResizeObserver(apply);
    if (element) observer.observe(element);
    window.addEventListener('resize', apply);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, []);

  // 共有 rAF ループを起動する(r3f の Canvas が持っていた描画ループの置き換え)。
  useEffect(() => {
    frameLoop.start();
    // 検証用フック(CLAUDE.md のブラウザ検証手順で使う)。読み書きともに有効で、
    // 書き込んだ値は次フレームの描画にそのまま反映される。
    (window as any).__webgpuCamera = cameraRef.current;
    return () => frameLoop.stop();
  }, []);

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
    railMap, stations, trains, towns, townTileIndex, newGame, field, worldSeed, halfExtent, terrainProfile, editedField, baseField, cornerDiffs, selectedTrainId, setSelectedTrainId,
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
    activeAccidents, handleAccident, handleStallRescue,
    currentLedger, ledgerHistory, handleMonthEnd,
    handleTownGrowth,
    stopLocation, setStopLocation,
    groups, createGroup, assignTrainToGroup, setGroupHeadway, setGroupMode,
    renameGroup, clearGroupSchedule, deleteGroup,
    gameRules,
  } = useGameLogic();

  return (
    <div ref={rootRef} style={{ width: '100vw', height: '100vh', background: '#cfe3ef', position: 'relative', overflow: 'hidden' }}>
      <WebGpuTerrainLayer
        key={`${worldSeed}:${halfExtent}:${terrainProfile}`}
        seed={worldSeed}
        halfExtent={halfExtent}
        terrainProfile={terrainProfile}
        cornerDiffs={cornerDiffs}
        layerRef={webGpuLayerRef}
        onUnavailable={handleRendererUnavailable}
        onReady={handleRendererReady}
      />

      <GameScene
        railMap={railMap}
        stations={stations}
        trains={trains}
        towns={towns}
        townTiles={townTileIndex}
        field={field}
        halfExtent={halfExtent}
        webGpuLayer={webGpuLayerRef}
        cameraRef={cameraRef}
        viewportRef={viewportRef}
        webGpuCameraStateRef={webgpuCameraStateRef}
        world={worldRef}
        buildMode={buildMode}
        buildLevel={buildLevel}
        stationAxis={stationAxis}
        selectedTrainId={selectedTrainId}
        isEditingSchedule={isEditingSchedule}
        simSpeed={simSpeed}
        money={money}
        onCommitPath={(path, mode, axisHint, level) => commitPath(
          path, mode, axisHint, level, effectiveRailOptions(gameRules, railOptions), regaugeTargetGauge,
          // L2: s2未満(信号種別の概念が無い)では常に'block'を書き込まず、種別欄そのものに
          // 触れない(既存セルの値を保つ)。設計意図(s2未満では種別の概念が無い)とセーブの
          // 素直さを揃える(挙動は変わらない: sim側の述語はもともとs2/s3以外で種別を見ない)。
          gameRules.signalling === 's2' || gameRules.signalling === 's3' ? signalKind : undefined
        )}
        removeSignal={removeSignal}
        onSimEvent={(event) => {
          if (event.type === 'arrive') handleTrainArrive(event.trainId, event.scheduleIndex);
          if (event.type === 'income') addIncome(event.amount);
          if (event.type === 'accident') handleAccident(event);
          if (event.type === 'stallRescue') handleStallRescue(event);
          if (event.type === 'monthEnd') handleMonthEnd(event);
          if (event.type === 'townGrowth') handleTownGrowth(event);
        }}
        onSelectTrain={setSelectedTrainId}
        onBuyTrain={(x, z) => buyTrain(x, z, purchasePower, purchaseProtection)}
        onAddSchedule={addSchedule}
        onSelectStation={selectStation}
        onPreviewChange={handlePreviewChange}
        groups={groups}
        onRelocateTrain={relocateTrainAt}
      />

      <GameUI
        buildMode={buildMode}
        setBuildMode={setBuildMode}
        buildLevel={buildLevel}
        setBuildLevel={setBuildLevel}
        stationAxis={stationAxis}
        setStationAxis={setStationAxis}
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
        onLoad={() => { loadGame(); setRailOptions({ gauge: DEFAULT_GAUGE }); }}
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
        groups={groups}
        onCreateGroup={createGroup}
        onAssignGroup={assignTrainToGroup}
        onSetHeadway={setGroupHeadway}
        onSetMode={setGroupMode}
        onRenameGroup={renameGroup}
        onClearGroupSchedule={clearGroupSchedule}
        onDeleteGroup={deleteGroup}
        gameRules={gameRules}
        railOptions={railOptions}
        setRailOptions={setRailOptions}
        regaugeTargetGauge={regaugeTargetGauge}
        setRegaugeTargetGauge={setRegaugeTargetGauge}
        purchasePower={purchasePower}
        purchaseProtection={purchaseProtection}
        setPurchaseProtection={setPurchaseProtection}
        setPurchasePower={setPurchasePower}
        signalKind={signalKind}
        setSignalKind={setSignalKind}
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
                        newGame(opt.halfExtent, selectedTownDensity, selectedTerrainProfile, {
                          ...PLAY_MODE_PRESETS[selectedPlayMode],
                          signalling: selectedSignalling,
                        });
                        // H2: 前のゲームで選んだ軌間/電化/保安装置/レール種別を持ち越さない
                        // (effectiveRailOptionsによるストリップが本体の保証だが、選択UI自体も
                        // 素直な既定へ戻しておく)。
                        setRailOptions({ gauge: DEFAULT_GAUGE });
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
                <p style={{ color: '#b9c3cc', lineHeight: 1.55, marginTop: 0 }}>地形</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: T.gap, marginBottom: T.gap }}>
                  {TERRAIN_PROFILE_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      style={{
                        ...themeButton({ active: selectedTerrainProfile === opt.value, compact: true }),
                        width: '100%',
                      }}
                      onClick={() => setSelectedTerrainProfile(opt.value)}
                      title={opt.hint}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p style={{ color: '#b9c3cc', lineHeight: 1.55, marginTop: 0 }}>プレイモード</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: T.gap, marginBottom: 4 }}>
                  {PLAY_MODE_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      style={{
                        ...themeButton({ active: selectedPlayMode === opt.value, compact: true }),
                        width: '100%',
                      }}
                      onClick={() => setSelectedPlayMode(opt.value)}
                      title={opt.hint}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p style={{ color: T.textMuted, fontSize: 11, lineHeight: 1.5, marginTop: 0, marginBottom: T.gap }}>
                  {PLAY_MODE_OPTIONS.find(opt => opt.value === selectedPlayMode)?.hint}
                </p>
                <p style={{ color: '#b9c3cc', lineHeight: 1.55, marginTop: 0 }}>信号方式</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: T.gap, marginBottom: 4 }}>
                  {SIGNALLING_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      style={{
                        ...themeButton({ active: selectedSignalling === opt.value, compact: true }),
                        width: '100%',
                      }}
                      onClick={() => setSelectedSignalling(opt.value)}
                      title={opt.hint}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p style={{ color: T.textMuted, fontSize: 11, lineHeight: 1.5, marginTop: 0, marginBottom: T.gap }}>
                  {SIGNALLING_OPTIONS.find(opt => opt.value === selectedSignalling)?.hint}
                </p>
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
                        setRailOptions({ gauge: DEFAULT_GAUGE });
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

      {unavailableReason && <UnavailableScreen reason={unavailableReason} />}
    </div>
  );
}
