import React, { useState, useMemo } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera, Environment } from '@react-three/drei';
import * as THREE from 'three';

import { DynamicTrain } from './DynamicTrain';
import { RailBlock } from './RailBlock';
import { DepotBlock } from './DepotBlock';
import { SignalBlock } from './SignalBlock';
import { StationLabel } from './StationLabel';
import { GROUND_COLOUR, STATION_COLOUR, DEPOT_COLOUR, SIGNAL_COLOUR } from '../types';
import type { CellData, CellType, TrainData, StationData } from '../types';
import { toKey, fromKey, getConstrainedPath } from '../utils';

const REMOVE_COLOUR = '#ff3333';

interface GameSceneProps {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  trains: TrainData[];
  buildMode: CellType | 'none' | 'remove' | 'signal';
  selectedTrainId: string | null;
  isEditingSchedule: boolean;
  
  onCommitPath: (path: { x: number; z: number }[], mode: CellType | 'none' | 'remove' | 'signal') => void;
  removeSignal: (x: number, z: number) => void;
  onTrainArrive: (trainId: string, idx: number) => void;
  onSelectTrain: (id: string | null) => void;
  onBuyTrain: (x: number, z: number) => void;
  onAddSchedule: (trainId: string, stationId: string) => void;
  // ★追加
  onUpdateTrainPath: (trainId: string, path: { x: number; z: number }[]) => void;
}

export const GameScene: React.FC<GameSceneProps> = ({
  railMap, stations, trains, buildMode, selectedTrainId, isEditingSchedule,
  onCommitPath, removeSignal, onTrainArrive, onSelectTrain, onBuyTrain, onAddSchedule, onUpdateTrainPath
}) => {
  const [cursorPos, setCursorPos] = useState<{ x: number; z: number } | null>(null);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; z: number } | null>(null);

  const previewPath = useMemo(() => {
    if (!dragStartPos || !cursorPos || buildMode === 'none') return [];
    if (buildMode === 'station' || buildMode === 'depot' || buildMode === 'signal') return [cursorPos];
    return getConstrainedPath(dragStartPos, cursorPos);
  }, [dragStartPos, cursorPos, buildMode]);

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => setCursorPos({ x: Math.round(e.point.x), z: Math.round(e.point.z) });
  
  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (buildMode === 'none') return;
    if (e.button === 0 && !e.shiftKey && cursorPos) setDragStartPos(cursorPos);
  };

  const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (buildMode === 'none') return;
    if (e.button === 0 && dragStartPos) {
      onCommitPath(previewPath, buildMode);
      setDragStartPos(null);
    }
  };

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (!cursorPos) return;

    if (buildMode === 'signal' && e.shiftKey) {
       removeSignal(cursorPos.x, cursorPos.z);
       return;
    }
    
    if (buildMode === 'none') {
        const key = toKey(cursorPos.x, cursorPos.z);
        const cell = railMap.get(key);
        if (cell && cell.type === 'station' && cell.stationId && selectedTrainId) {
            if (isEditingSchedule) onAddSchedule(selectedTrainId, cell.stationId);
            return;
        }
        if (cell && cell.type === 'depot') {
            onBuyTrain(cursorPos.x, cursorPos.z);
            return;
        }
        onSelectTrain(null);
    }
  };

  const getPreviewColor = () => {
    if (buildMode === 'station') return STATION_COLOUR;
    if (buildMode === 'depot') return DEPOT_COLOUR;
    if (buildMode === 'remove') return REMOVE_COLOUR;
    if (buildMode === 'signal') return SIGNAL_COLOUR;
    return "#00aaff";
  };

  const selectedTrain = trains.find(t => t.id === selectedTrainId);

  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 5]} intensity={1} castShadow />
      <Environment preset="city" />
      <OrthographicCamera makeDefault position={[20, 20, 20]} zoom={40} near={-50} far={200} />
      <OrbitControls makeDefault enableRotate={false} enableZoom={true} minZoom={20} maxZoom={100} mouseButtons={{ LEFT: undefined as any, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }} />

      {!dragStartPos && cursorPos && buildMode !== 'none' && (
        <mesh position={[cursorPos.x, 0.1, cursorPos.z]}>
          <boxGeometry args={[1, 0.2, 1]} />
          <meshBasicMaterial color={getPreviewColor()} transparent opacity={0.5} />
        </mesh>
      )}

      {dragStartPos && previewPath.map((pos, i) => {
         if (buildMode === 'station' || buildMode === 'depot' || buildMode === 'remove' || buildMode === 'signal') {
            return (
              <mesh key={`preview-${i}`} position={[pos.x, 0.25, pos.z]}>
                <boxGeometry args={[0.9, 0.5, 0.9]} />
                <meshStandardMaterial color={getPreviewColor()} transparent opacity={0.6} />
              </mesh>
            );
         }
         return <RailBlock key={`preview-${i}`} position={[pos.x, 0.05, pos.z]} isPreview={true} connections={0} />;
      })}

      {Array.from(railMap.entries()).map(([key, data]) => {
        const { x, z } = fromKey(key);
        const elements = [];
        if (data.type === 'station') {
          elements.push(<mesh key={key} position={[x, 0.25, z]}><boxGeometry args={[0.9, 0.5, 0.9]} /><meshStandardMaterial color={STATION_COLOUR} /></mesh>);
        } else if (data.type === 'depot') {
           elements.push(<DepotBlock key={key} position={[x, 0, z]} rotation={data.rotation} />);
        } else {
           elements.push(<RailBlock key={key} position={[x, 0.05, z]} connections={data.connections} />);
        }
        if (data.signalDir) {
           elements.push(<SignalBlock key={`${key}-sig`} position={[x, 0.05, z]} dir={data.signalDir} />);
        }
        return <group key={key}>{elements}</group>;
      })}

      {Array.from(stations.values()).map(station => {
        const orderIndices: number[] = [];
        if (selectedTrain) {
          selectedTrain.schedule.forEach((stId, index) => {
            if (stId === station.id) {
              orderIndices.push(index);
            }
          });
        }
        return <StationLabel key={station.id} station={station} orderIndices={orderIndices} />;
      })}

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} onPointerMove={handlePointerMove} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onPointerLeave={handlePointerUp} onClick={handleClick}>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color={GROUND_COLOUR} />
      </mesh>
      <gridHelper args={[100, 100, 0x888888, 0xcccccc]} position={[0, 0.01, 0]} />

      {trains.map(train => (
        <DynamicTrain 
          key={train.id} data={train} type="commuter" railMap={railMap} stations={stations} allTrains={trains}
          isSelected={train.id === selectedTrainId} onArriveStation={onTrainArrive}
          onClick={() => buildMode === 'none' && onSelectTrain(train.id)}
          onUpdatePath={onUpdateTrainPath} // 追加
        />
      ))}
    </>
  );
};