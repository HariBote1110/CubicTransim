import React, { useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { useGameLogic } from './hooks/useGameLogic';
import { GameScene } from './components/GameScene';
import { GameUI } from './components/GameUI';
import type { CellType } from './types';

export default function App() {
  const [buildMode, setBuildMode] = useState<CellType | 'none' | 'remove' | 'signal'>('rail');
  
  const { 
    railMap, stations, trains, selectedTrainId, setSelectedTrainId,
    isEditingSchedule, setIsEditingSchedule,
    commitPath, removeSignal, handleTrainArrive, 
    buyTrain, deployTrain, 
    addSchedule, updateTrainPath // 追加
  } = useGameLogic();

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#f0f0f0', position: 'relative' }}>
      <Canvas shadows>
        <GameScene 
          railMap={railMap}
          stations={stations}
          trains={trains}
          buildMode={buildMode}
          selectedTrainId={selectedTrainId}
          isEditingSchedule={isEditingSchedule}
          onCommitPath={commitPath}
          removeSignal={removeSignal}
          onTrainArrive={handleTrainArrive}
          onSelectTrain={setSelectedTrainId}
          onBuyTrain={buyTrain}
          onAddSchedule={addSchedule}
          onUpdateTrainPath={updateTrainPath} // 追加
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
      />
    </div>
  );
}