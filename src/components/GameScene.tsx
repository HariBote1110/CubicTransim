import React, { useState, useMemo } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera } from '@react-three/drei';
import * as THREE from 'three';

import { DynamicTrain } from './DynamicTrain';
import { SimulationDriver } from './SimulationDriver';
import { RailBlock } from './RailBlock';
import { TrackNetwork } from './TrackNetwork';
import { DepotBlock } from './DepotBlock';
import { SignalBlock } from './SignalBlock';
import { StationLabel } from './StationLabel';
import { StationBlock, StationHouse, trackAngleFromConnections } from './StationBlock';
import { TownBlocks } from './TownBlocks';
import { Scenery } from './Scenery';
import { STATION_COLOUR, DEPOT_COLOUR, SIGNAL_COLOUR } from '../types';
import type { CellData, CellType, TrainData, TrainGroupData, StationData, TownData, TerrainType } from '../types';
import { findGroup } from '../sim/groups';
import { toKey, fromKey, getConstrainedPath } from '../utils';
import type { SimWorld, SimEvent } from '../sim/simulation';
import { TerrainBlocks } from './TerrainBlocks';
import { createGroundTexture } from '../render/groundTexture';

const REMOVE_COLOUR = '#ff3b47';

/**
 * 太陽光(影を落とす平行光源)。
 *
 * 注意点が2つある:
 * 1. react-three-fiber は shadow-camera-* を設定しても projectionMatrix を
 *    更新しないため、宣言的に書くとシャドウカメラが既定の±5のままになり、
 *    原点付近のごく狭い範囲にしか影が出ない(=事実上、影が消える)。
 *    ref 経由で範囲を設定し、明示的に updateProjectionMatrix を呼ぶ必要がある。
 * 2. 光源をカメラ(+x,+y,+z 方向)と同じ側に置くと、影が物体の裏側=画面上で
 *    物体自身に隠れる位置に落ちてしまい、影が無いように見える。
 *    -x 側から差す横光にして、影が画面右下方向へ伸びるようにしている。
 */
const SHADOW_EXTENT = 46;

const SunLight: React.FC = () => {
  const ref = React.useRef<THREE.DirectionalLight>(null);

  React.useEffect(() => {
    const light = ref.current;
    if (!light) return;
    const cam = light.shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = 1;
    cam.far = 120;
    cam.updateProjectionMatrix();
    // mapSize は prop で先に与えてある。既に生成済みのシャドウマップがあれば
    // 破棄して、更新後のカメラ・解像度で作り直させる。
    if (light.shadow.map) {
      light.shadow.map.dispose();
      light.shadow.map = null as unknown as typeof light.shadow.map;
    }
    (window as any).__sun = light;
  }, []);

  return (
    <directionalLight
      ref={ref}
      position={[-30, 34, 14]}
      intensity={1.75}
      color="#fff3df"
      castShadow
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0004}
      shadow-normalBias={0.03}
    />
  );
};

interface GameSceneProps {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  trains: TrainData[];
  towns: TownData[];
  terrain: Map<string, TerrainType>;
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
  // ★追加: 建設プレビュー(コスト・可否)をUIへ通知する
  onPreviewChange?: (path: { x: number; z: number }[]) => void;
  // ★追加: 運用グループ。所属列車の帯をグループのラインカラーで塗る。
  groups?: TrainGroupData[];
}

export const GameScene: React.FC<GameSceneProps> = ({
  railMap, stations, trains, towns, terrain, world, buildMode, selectedTrainId, isEditingSchedule, simSpeed,
  onCommitPath, removeSignal, onSimEvent, onSelectTrain, onBuyTrain, onAddSchedule, onSelectStation,
  onPreviewChange, groups = [],
}) => {
  const [cursorPos, setCursorPos] = useState<{ x: number; z: number } | null>(null);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; z: number } | null>(null);

  const previewPath = useMemo(() => {
    if (buildMode === 'none' || !cursorPos) return [];
    if (!dragStartPos) return [cursorPos];
    if (buildMode === 'station' || buildMode === 'depot' || buildMode === 'signal') return [cursorPos];
    return getConstrainedPath(dragStartPos, cursorPos);
  }, [dragStartPos, cursorPos, buildMode]);

  // 建設プレビューの内容をUI(コスト・可否の表示)へ流す。
  React.useEffect(() => {
    onPreviewChange?.(previewPath);
  }, [previewPath, onPreviewChange]);

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
    return '#3ab6ff';
  };

  const selectedTrain = trains.find(t => t.id === selectedTrainId);

  const tunnelKeys = useMemo(
    () => new Set(Array.from(railMap.entries()).filter(([, d]) => d.tunnel).map(([key]) => key)),
    [railMap]
  );

  // 草地のテクスチャ(色ムラ)。1度だけ生成して使い回す。
  const groundTexture = useMemo(() => createGroundTexture(), []);
  React.useEffect(() => () => groundTexture.dispose(), [groundTexture]);

  // 駅セルがホームの端かどうか(=同一stationIdの隣接セルが1つ以下)を判定する。
  // 端のセルだけ上屋の妻側にも柱を立てて、ホームが尻切れに見えないようにする。
  const stationEndKeys = useMemo(() => {
    const ends = new Set<string>();
    for (const [key, data] of railMap) {
      if (data.type !== 'station' || !data.stationId) continue;
      const { x, z } = fromKey(key);
      let neighbours = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dz === 0) continue;
          if (railMap.get(toKey(x + dx, z + dz))?.stationId === data.stationId) neighbours++;
        }
      }
      if (neighbours <= 1) ends.add(key);
    }
    return ends;
  }, [railMap]);

  return (
    <>
      <hemisphereLight args={['#dcefff', '#75825a', 0.55]} />
      <ambientLight intensity={0.2} />
      <SunLight />
      <OrthographicCamera makeDefault position={[20, 20, 20]} zoom={40} near={-50} far={200} />
      <OrbitControls makeDefault enableRotate={false} enableZoom={true} minZoom={20} maxZoom={100} mouseButtons={{ LEFT: undefined as any, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }} />

      {/* 建設プレビュー */}
      {previewPath.map((pos, i) => (
        buildMode === 'rail'
          ? <RailBlock key={`preview-${i}`} position={[pos.x, 0.02, pos.z]} isPreview connections={0} />
          : (
            <mesh key={`preview-${i}`} position={[pos.x, 0.2, pos.z]}>
              <boxGeometry args={[0.92, 0.4, 0.92]} />
              <meshBasicMaterial color={getPreviewColor()} transparent opacity={0.45} depthWrite={false} />
            </mesh>
          )
      ))}

      <TerrainBlocks terrain={terrain} tunnelKeys={tunnelKeys} />
      <Scenery terrain={terrain} railMap={railMap} towns={towns} />
      <TrackNetwork railMap={railMap} />

      {Array.from(railMap.entries()).map(([key, data]) => {
        const { x, z } = fromKey(key);
        const elements = [];
        if (data.type === 'station') {
          elements.push(
            <StationBlock
              key={key}
              position={[x, 0, z]}
              connections={data.connections}
              platformDoors={stations.get(data.stationId ?? '')?.platformDoors ?? 'none'}
              isEnd={stationEndKeys.has(key)}
            />
          );
        } else if (data.type === 'depot') {
           elements.push(<DepotBlock key={key} position={[x, 0, z]} rotation={data.rotation} />);
        }
        if (data.signalDir) {
           elements.push(<SignalBlock key={`${key}-sig`} position={[x, 0.05, z]} dir={data.signalDir} />);
        }
        // 橋(水上の線路)は桁と橋脚を、トンネル(山岳の線路)は坑口を表す。
        if (data.bridge) {
          elements.push(
            <group key={`${key}-bridge`}>
              <mesh position={[x, -0.03, z]} castShadow>
                <boxGeometry args={[0.72, 0.12, 1.0]} />
                <meshStandardMaterial color="#8a7a68" roughness={0.95} />
              </mesh>
              {[-0.3, 0.3].map(o => (
                <mesh key={o} position={[x + o, -0.18, z]}>
                  <boxGeometry args={[0.1, 0.26, 0.16]} />
                  <meshStandardMaterial color="#7b6c5c" roughness={1} />
                </mesh>
              ))}
            </group>
          );
        }
        if (data.tunnel) {
          elements.push(
            <group key={`${key}-tunnel`}>
              <mesh position={[x, 0.3, z]} castShadow>
                <boxGeometry args={[1.0, 0.6, 1.0]} />
                <meshStandardMaterial color="#77726a" roughness={1} flatShading />
              </mesh>
              <mesh position={[x, 0.22, z]}>
                <boxGeometry args={[0.56, 0.42, 1.02]} />
                <meshStandardMaterial color="#14181d" roughness={1} />
              </mesh>
            </group>
          );
        }
        return <group key={key}>{elements}</group>;
      })}

      <TownBlocks towns={towns} />

      {Array.from(stations.values()).map(station => {
        const orderIndices: number[] = [];
        if (selectedTrain) {
          selectedTrain.schedule.forEach((stId, index) => {
            if (stId === station.id) orderIndices.push(index);
          });
        }
        const centreCell = station.cells[Math.floor(station.cells.length / 2)] ?? station.center;
        const angle = trackAngleFromConnections(railMap.get(toKey(centreCell.x, centreCell.z))?.connections);
        return (
          <group key={station.id}>
            <StationHouse position={[centreCell.x, 0, centreCell.z]} angle={angle} />
            <StationLabel station={station} orderIndices={orderIndices} world={world} />
          </group>
        );
      })}

      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.02, 0]}
        receiveShadow
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onClick={handleClick}
      >
        <planeGeometry args={[140, 140]} />
        <meshStandardMaterial map={groundTexture} color="#ffffff" roughness={1} />
      </mesh>

      {/* 建設モードのときだけグリッドを出す(通常時はジオラマの見た目を邪魔しない) */}
      {buildMode !== 'none' && (
        <gridHelper args={[120, 120, 0x7f9c68, 0x9fbb84]} position={[0, 0.004, 0]} />
      )}

      <SimulationDriver world={world} onSimEvent={onSimEvent} speed={simSpeed} />

      {trains.map(train => (
        <DynamicTrain
          key={train.id} data={train} runtimes={world.current.runtimes} type="commuter"
          isSelected={train.id === selectedTrainId}
          lineColour={findGroup(groups, train.groupId)?.colour}
          onClick={() => buildMode === 'none' && onSelectTrain(train.id)}
        />
      ))}
    </>
  );
};
