import { useCallback, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { useGameLogic } from './hooks/useGameLogic';
import { GameScene } from './components/GameScene';
import { GameUI } from './components/GameUI';
import type { BuildMode } from './components/GameUI';
import { STATION_TEMPLATES } from './sim/stationTemplates';
import { defaultTemplateId } from './ui/templateRotation';
import type { QuarterTurns } from './ui/templateRotation';

export default function App() {
  const [buildMode, setBuildMode] = useState<BuildMode>('none');
  const [simSpeed, setSimSpeed] = useState<0 | 1 | 2 | 4>(1);
  // 建設プレビュー中のセル列。GameScene(カーソル/ドラッグ)からGameUI(コスト表示)へ橋渡しする。
  const [previewPath, setPreviewPath] = useState<{ x: number; z: number }[]>([]);
  // ★追加: 駅テンプレート(どのテンプレートを、どの向きで置くか)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(defaultTemplateId(STATION_TEMPLATES) ?? '');
  const [quarterTurns, setQuarterTurns] = useState<QuarterTurns>(0);

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
    railMap, stations, trains, towns, terrain, selectedTrainId, setSelectedTrainId,
    isEditingSchedule, setIsEditingSchedule,
    commitPath, commitTemplate, removeSignal, handleTrainArrive,
    buyTrain, deployTrain,
    addCar, removeCar,
    addSchedule, worldRef, relocateTrainAt,
    scheduleClipboard, copySchedule, pasteSchedule,
    saveGame, loadGame,
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
          terrain={terrain}
          world={worldRef}
          buildMode={buildMode}
          selectedTrainId={selectedTrainId}
          isEditingSchedule={isEditingSchedule}
          simSpeed={simSpeed}
          money={money}
          onCommitPath={commitPath}
          selectedTemplateId={selectedTemplateId}
          quarterTurns={quarterTurns}
          onCommitTemplate={(anchor) => commitTemplate(anchor, selectedTemplateId, quarterTurns)}
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
        selectedTrainId={selectedTrainId}
        trains={trains}
        stations={stations}
        railMap={railMap}
        terrain={terrain}
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
        selectedTemplateId={selectedTemplateId}
        setSelectedTemplateId={setSelectedTemplateId}
        quarterTurns={quarterTurns}
        setQuarterTurns={setQuarterTurns}
        groups={groups}
        onCreateGroup={createGroup}
        onAssignGroup={assignTrainToGroup}
        onSetHeadway={setGroupHeadway}
        onSetMode={setGroupMode}
        onRenameGroup={renameGroup}
        onClearGroupSchedule={clearGroupSchedule}
        onDeleteGroup={deleteGroup}
      />
    </div>
  );
}
