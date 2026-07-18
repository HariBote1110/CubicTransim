import React, { useState, useMemo } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera, Environment } from '@react-three/drei';
import * as THREE from 'three';

import { DynamicTrain } from './DynamicTrain';
import { SimulationDriver } from './SimulationDriver';
import { RailBlock } from './RailBlock';
import { DepotBlock } from './DepotBlock';
import { SignalBlock } from './SignalBlock';
import { StationLabel } from './StationLabel';
import { GROUND_COLOUR, STATION_COLOUR, DEPOT_COLOUR, SIGNAL_COLOUR } from '../types';
import type { CellData, CellType, TrainData, StationData } from '../types';
import { toKey, fromKey, getConstrainedPath } from '../utils';
import type { SimWorld, SimEvent } from '../sim/simulation';

const REMOVE_COLOUR = '#ff3333';

interface GameSceneProps {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  trains: TrainData[];
  world: React.RefObject<SimWorld>;
  buildMode: CellType | 'none' | 'remove' | 'signal';
  selectedTrainId: string | null;
  isEditingSchedule: boolean;
  simSpeed: number;

  onCommitPath: (path: { x: number; z: number }[], mode: CellType | 'none' | 'remove' | 'signal') => void;
  removeSignal: (x: number, z: number) => void;
  onSimEvent: (event: SimEvent) => void;
  onSelectTrain: (id: string | null) => void;
  onBuyTrain: (x: number, z: number) => void;
  onAddSchedule: (trainId: string, stationId: string) => void;
  // ★追加: 駅選択(人身事故とホームドア)
  onSelectStation: (id: string | null) => void;
}

export const GameScene: React.FC<GameSceneProps> = ({
  railMap, stations, trains, world, buildMode, selectedTrainId, isEditingSchedule, simSpeed,
  onCommitPath, removeSignal, onSimEvent, onSelectTrain, onBuyTrain, onAddSchedule, onSelectStation
}) => {
  const [cursorPos, setCursorPos] = useState<{ x: number; z: number } | null>(null);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; z: number } | null>(null);

  const previewPath = useMemo(() => {
    if (!dragStartPos || !cursorPos || buildMode === 'none') return [];
    if (buildMode === 'station' || buildMode === 'depot' || buildMode === 'signal') return [cursorPos];
    return getConstrainedPath(dragStartPos, cursorPos);
  }, [dragStartPos, cursorPos, buildMode]);

  // e.point から直接グリッド座標を求める。cursorPos（React state）は
  // pointermove でしか更新されないため、モード切替直後の1回目のクリックなど
  // pointermove が発火する前に押下/クリックされた場合に古い位置を参照してしまう
  // 不具合（バグ4）があった。hover プレビュー用の cursorPos はそのまま残す。
  const getGridPosFromEvent = (e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>) => ({
    x: Math.round(e.point.x),
    z: Math.round(e.point.z),
  });

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => setCursorPos(getGridPosFromEvent(e));

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (buildMode === 'none') return;
    if (e.button === 0 && !e.shiftKey) setDragStartPos(getGridPosFromEvent(e));
  };

  const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (buildMode === 'none') return;
    if (e.button === 0 && dragStartPos) {
      const pos = getGridPosFromEvent(e);
      const path = (buildMode === 'station' || buildMode === 'depot' || buildMode === 'signal')
        ? [pos]
        : getConstrainedPath(dragStartPos, pos);
      onCommitPath(path, buildMode);
      setDragStartPos(null);
    }
  };

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const pos = getGridPosFromEvent(e);

    if (buildMode === 'signal' && e.shiftKey) {
       removeSignal(pos.x, pos.z);
       return;
    }

    if (buildMode === 'none') {
        const key = toKey(pos.x, pos.z);
        const cell = railMap.get(key);
        if (cell && cell.type === 'station' && cell.stationId && selectedTrainId) {
            if (isEditingSchedule) onAddSchedule(selectedTrainId, cell.stationId);
            return;
        }
        // 列車未選択かつスケジュール編集中でなければ駅を選択する(人身事故とホームドア)
        if (cell && cell.type === 'station' && cell.stationId && !selectedTrainId && !isEditingSchedule) {
            onSelectStation(cell.stationId);
            return;
        }
        if (cell && cell.type === 'depot') {
            onBuyTrain(pos.x, pos.z);
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
        return <StationLabel key={station.id} station={station} orderIndices={orderIndices} world={world} />;
      })}

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} onPointerMove={handlePointerMove} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onPointerLeave={handlePointerUp} onClick={handleClick}>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color={GROUND_COLOUR} />
      </mesh>
      <gridHelper args={[100, 100, 0x888888, 0xcccccc]} position={[0, 0.01, 0]} />

      <SimulationDriver world={world} onSimEvent={onSimEvent} speed={simSpeed} />

      {trains.map(train => (
        <DynamicTrain
          key={train.id} data={train} runtimes={world.current.runtimes} type="commuter"
          isSelected={train.id === selectedTrainId}
          onClick={() => buildMode === 'none' && onSelectTrain(train.id)}
        />
      ))}
    </>
  );
};