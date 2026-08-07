import { useCallback, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { useGameLogic } from './hooks/useGameLogic';
import { GameScene } from './components/GameScene';
import { GameUI } from './components/GameUI';
import type { BuildMode } from './components/GameUI';
import type { BuildLevel } from './sim/construction';
import { DEBUG_SCENARIOS } from './sim/debugScenarios';
import { T, button as themeButton } from './ui/theme';

export default function App() {
  const [showStartupOptions, setShowStartupOptions] = useState(true);
  // 起動ダイアログで「デバッグモード」を押すと、シナリオ一覧(sim/debugScenarios.ts)を表示する。
  const [showDebugScenarios, setShowDebugScenarios] = useState(false);
  const [buildMode, setBuildMode] = useState<BuildMode>('none');
  // 線路(rail)・駅(station)ツールの建設対象レベル(0=地平〜3、既定0)。GameUIのArrowUp/Down、
  // GameScene(プレビュー・commit)双方から参照するため、共通の親であるAppで保持する。
  const [buildLevel, setBuildLevel] = useState<BuildLevel>(0);
  const [simSpeed, setSimSpeed] = useState<0 | 1 | 2 | 4>(1);
  // 建設プレビュー中のセル列。GameScene(カーソル/ドラッグ)からGameUI(コスト表示)へ橋渡しする。
  const [previewPath, setPreviewPath] = useState<{ x: number; z: number }[]>([]);

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
    railMap, stations, trains, towns, townTileIndex, townSubTileIndex, field, halfExtent, editedField, baseField, selectedTrainId, setSelectedTrainId,
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

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#cfe3ef', position: 'relative', overflow: 'hidden' }}>
      <Canvas shadows>
        <GameScene
          railMap={railMap}
          stations={stations}
          trains={trains}
          towns={towns}
          townTiles={townTileIndex}
          townSubTiles={townSubTileIndex}
          field={field}
          halfExtent={halfExtent}
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
                <p style={{ color: '#b9c3cc', lineHeight: 1.55 }}>開始方法を選択してください。</p>
                <button
                  style={{ ...themeButton({ active: true }), width: '100%', marginBottom: T.gap }}
                  onClick={() => setShowStartupOptions(false)}
                >
                  通常のゲームを開始
                </button>
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
