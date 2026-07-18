import { useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { useGameLogic } from './hooks/useGameLogic';
import { GameScene } from './components/GameScene';
import { GameUI } from './components/GameUI';
import type { CellType } from './types';

export default function App() {
  const [buildMode, setBuildMode] = useState<CellType | 'none' | 'remove' | 'signal'>('rail');
  const [simSpeed, setSimSpeed] = useState<0 | 1 | 2 | 4>(1);

  const {
    railMap, stations, trains, selectedTrainId, setSelectedTrainId,
    isEditingSchedule, setIsEditingSchedule,
    commitPath, removeSignal, handleTrainArrive,
    buyTrain, deployTrain,
    addSchedule, worldRef,
    scheduleClipboard, copySchedule, pasteSchedule,
    saveGame, loadGame,
    money, addIncome
  } = useGameLogic();

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#f0f0f0', position: 'relative' }}>
      <Canvas shadows>
        <GameScene
          railMap={railMap}
          stations={stations}
          trains={trains}
          world={worldRef}
          buildMode={buildMode}
          selectedTrainId={selectedTrainId}
          isEditingSchedule={isEditingSchedule}
          simSpeed={simSpeed}
          onCommitPath={commitPath}
          removeSignal={removeSignal}
          onSimEvent={(event) => {
            if (event.type === 'arrive') handleTrainArrive(event.trainId, event.scheduleIndex);
            if (event.type === 'income') addIncome(event.amount);
          }}
          onSelectTrain={setSelectedTrainId}
          onBuyTrain={buyTrain}
          onAddSchedule={addSchedule}
        />
      </Canvas>
      
      <GameUI
        buildMode={buildMode}
        setBuildMode={setBuildMode}
        selectedTrainId={selectedTrainId}
        trains={trains}
        stations={stations}
        isEditingSchedule={isEditingSchedule}
        setIsEditingSchedule={setIsEditingSchedule}
        onDeploy={deployTrain}
        scheduleClipboard={scheduleClipboard}
        onCopySchedule={copySchedule}
        onPasteSchedule={pasteSchedule}
        simSpeed={simSpeed}
        setSimSpeed={setSimSpeed}
        onSave={saveGame}
        onLoad={loadGame}
        money={money}
        world={worldRef}
      />
    </div>
  );
}