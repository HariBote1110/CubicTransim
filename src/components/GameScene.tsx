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
import type { StationAxis } from '../sim/construction';
import { resolveElevatedPathEnd, planElevatedPath } from '../sim/construction';
import { canPlaceTrainAt, trainAtCell } from '../sim/relocate';
import { TerrainBlocks } from './TerrainBlocks';
import { createGroundTexture } from '../render/groundTexture';
import { T } from '../ui/theme';
import type { BuildMode } from './GameUI';
import { OVERPASS_HEIGHT } from '../sim/trackPath';
import {
  groundStationCells, elevatedStationCells, computeStationEndKeys, elevatedCellCandidateFromGroundClick,
} from '../render/stationLayers';

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
  buildMode: BuildMode;
  selectedTrainId: string | null;
  isEditingSchedule: boolean;
  simSpeed: number;
  money: number;

  onCommitPath: (
    path: { x: number; z: number }[],
    mode: CellType | 'none' | 'remove' | 'signal' | 'elevated' | 'elevated-station',
    // 駅設置(station)専用: ドラッグ方向から決まる軸のヒント(南北/東西)。
    stationAxisHint?: StationAxis
  ) => void;
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
  // ★追加: デッドロック救済用、列車のドラッグ置き直し(プラレールを掴んで動かす操作)。
  // 成否に関わらずGameScene側で状態をリセットするため、戻り値は使わない。
  onRelocateTrain?: (trainId: string, x: number, z: number) => void;
}

export const GameScene: React.FC<GameSceneProps> = ({
  railMap, stations, trains, towns, terrain, world, buildMode, selectedTrainId, isEditingSchedule, simSpeed,
  onCommitPath, removeSignal, onSimEvent, onSelectTrain, onBuyTrain, onAddSchedule, onSelectStation,
  onPreviewChange, groups = [], onRelocateTrain,
}) => {
  const [cursorPos, setCursorPos] = useState<{ x: number; z: number } | null>(null);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; z: number } | null>(null);
  // dragStartPos の実体はこの ref に持つ。handlePointerUp が読むのは常にこちら。
  // 理由: pointerdown→pointerup が同期的に(間にpointermoveの再描画が挟まらずに)
  // 発生する「動かさない単発クリック」では、pointerdownのsetDragStartPosがまだ
  // コミットされておらず、pointerup側のクロージャは1つ前の描画時点のdragStartPos
  // (=1クリック前の値、モード切替直後なら null)を読んでしまう。地平線路と高架桁が
  // 重なる交差セルへの単発クリックで駅が置けなかった不具合の原因はこれで、
  // ドラッグ時は途中のpointermoveで再描画が挟まるため症状が出なかった。
  // state (dragStartPos) はプレビュー描画用にそのまま残し、コミット判定にはrefを使う。
  const dragStartRef = React.useRef<{ x: number; z: number } | null>(null);

  // 列車ドラッグ(プラレールを掴んで移動する操作)。操作の起点は地面プレーンの
  // onPointerDown(押下したセルに列車がいるかをtrainAtCellで判定する)。列車メッシュ
  // 自身のonPointerDownには依存しない(発火しない/拾えないケースがあり選択できなく
  // なる不具合の原因だったため。詳細はprogress/train-relocate-drag.md参照)。
  // 押下したセルから動くまでは「押しているだけ」(=クリック候補)とみなし、選択モード
  // (buildMode==='none')のクリックによる列車選択と競合しないようにする。
  const [trainPress, setTrainPress] = useState<{ id: string; startCell: { x: number; z: number } } | null>(null);
  const [draggingTrainId, setDraggingTrainId] = useState<string | null>(null);
  // ドラッグ確定直後に発生しうる余計なクリック(=選択解除やクリック選択)を1回だけ無視する。
  const justDraggedRef = React.useRef(false);

  const canDropTrainHere = useMemo(() => {
    if (!draggingTrainId || !cursorPos) return false;
    return !!canPlaceTrainAt(world.current, draggingTrainId, cursorPos);
  }, [draggingTrainId, cursorPos, world]);

  const previewPath = useMemo(() => {
    if (buildMode === 'none' || !cursorPos) return [];
    if (!dragStartPos) return [cursorPos];
    if (buildMode === 'station' || buildMode === 'depot' || buildMode === 'signal' || buildMode === 'elevated-station') {
      return [cursorPos];
    }
    return getConstrainedPath(dragStartPos, cursorPos);
  }, [dragStartPos, cursorPos, buildMode]);

  // 高架線(elevated)プレビューの各セルの役割(坂/高架のまま)。construction.tsの
  // resolveElevatedPathEnd/planElevatedPathにそのまま問い合わせる(UIにルールを書き写さない)。
  const elevatedPreviewPlan = useMemo(() => {
    if (buildMode !== 'elevated' || previewPath.length < 2) return null;
    const startInfo = resolveElevatedPathEnd(railMap, previewPath[0]);
    const endInfo = resolveElevatedPathEnd(railMap, previewPath[previewPath.length - 1]);
    return planElevatedPath(previewPath.length, startInfo.continuesElevated, endInfo.continuesElevated);
  }, [buildMode, previewPath, railMap]);

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

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    const pos = getGridPosFromEvent(e);
    setCursorPos(pos);
    // 列車を押下したまま別セルへ動いたら、そこでクリック候補からドラッグへ昇格する。
    if (trainPress && !draggingTrainId && (pos.x !== trainPress.startCell.x || pos.z !== trainPress.startCell.z)) {
      setDraggingTrainId(trainPress.id);
    }
  };

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (buildMode === 'none') {
      // 選択モード: 押下したセルに列車がいれば「掴んだ」状態にする(ドラッグ候補)。
      // 実際のドラッグへの昇格はhandlePointerMoveで別セルへ動いた時点。
      const pos = getGridPosFromEvent(e);
      const trainId = trainAtCell(world.current, pos);
      if (trainId) setTrainPress({ id: trainId, startCell: pos });
      return;
    }
    if (e.button === 0 && !e.shiftKey) {
      const pos = getGridPosFromEvent(e);
      dragStartRef.current = pos;
      setDragStartPos(pos);
    }
  };

  const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
    // 選択モードでの列車ドラッグの決着はここで行う(建設モードのドラッグより先に処理する)。
    // クリックによる選択はDynamicTrain側のonClickに任せる(ここではtrainPressをリセットするのみ)。
    if (buildMode === 'none') {
      if (draggingTrainId) {
        const pos = getGridPosFromEvent(e);
        onRelocateTrain?.(draggingTrainId, pos.x, pos.z);
        setDraggingTrainId(null);
        setTrainPress(null);
        justDraggedRef.current = true;
      } else if (trainPress) {
        setTrainPress(null);
      }
      return;
    }
    const start = dragStartRef.current;
    if (e.button === 0 && start) {
      const pos = getGridPosFromEvent(e);
      const path = (buildMode === 'station' || buildMode === 'depot' || buildMode === 'signal' || buildMode === 'elevated-station')
        ? [pos]
        : getConstrainedPath(start, pos);
      // 駅設置(station)は常に単一セルを置くが、ドラッグした向きを軸のヒントとしてUI側から渡す。
      // (押下位置=解放位置で向きが分からない場合はヒント無しにし、隣接セルからの推測に任せる)
      let stationAxisHint: StationAxis | undefined;
      if (buildMode === 'station') {
        const dx = Math.abs(pos.x - start.x);
        const dz = Math.abs(pos.z - start.z);
        if (dx > 0 || dz > 0) stationAxisHint = dx >= dz ? 'ew' : 'ns';
      }
      onCommitPath(path, buildMode, stationAxisHint);
      dragStartRef.current = null;
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
        // 地平にヒットするものが無ければ、直交カメラの見え方から「見えている高架駅セル」の
        // 候補を逆算して確認する(完璧な判定ではないが、高架ホームをクリックして駅を選べる)。
        const elevatedCandidate = elevatedCellCandidateFromGroundClick(pos);
        const elevatedCell = railMap.get(toKey(elevatedCandidate.x, elevatedCandidate.z));
        const elevatedStationId = elevatedCell?.uppers?.[1]?.stationId;
        if (elevatedStationId && selectedTrainId) {
            if (isEditingSchedule) onAddSchedule(selectedTrainId, elevatedStationId);
            return;
        }
        if (elevatedStationId && !selectedTrainId && !isEditingSchedule) {
            onSelectStation(elevatedStationId);
            return;
        }
        onSelectTrain(null);
    }
  };

  const getPreviewColor = () => {
    if (buildMode === 'station' || buildMode === 'elevated-station') return STATION_COLOUR;
    if (buildMode === 'depot') return DEPOT_COLOUR;
    if (buildMode === 'remove') return REMOVE_COLOUR;
    if (buildMode === 'signal') return SIGNAL_COLOUR;
    if (buildMode === 'elevated') return T.bridge;
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
  // 地平・高架は別の層として独立に集計する(render/stationLayers.ts参照)。
  const groundCells = useMemo(() => groundStationCells(railMap), [railMap]);
  const elevatedCells = useMemo(() => elevatedStationCells(railMap), [railMap]);
  const stationEndKeys = useMemo(() => computeStationEndKeys(groundCells), [groundCells]);
  const elevatedEndKeys = useMemo(() => computeStationEndKeys(elevatedCells), [elevatedCells]);

  return (
    <>
      <hemisphereLight args={['#dcefff', '#75825a', 0.55]} />
      <ambientLight intensity={0.2} />
      <SunLight />
      <OrthographicCamera makeDefault position={[20, 20, 20]} zoom={40} near={-50} far={200} />
      <OrbitControls makeDefault enableRotate={false} enableZoom={true} minZoom={20} maxZoom={100} mouseButtons={{ LEFT: undefined as any, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }} />

      {/* 建設プレビュー。高架(elevated)は坂になるセルと高架のままのセルを色分けする。 */}
      {previewPath.map((pos, i) => {
        if (buildMode === 'rail') {
          return <RailBlock key={`preview-${i}`} position={[pos.x, 0.02, pos.z]} isPreview connections={0} />;
        }
        const role = elevatedPreviewPlan?.roles[i];
        const color = buildMode === 'elevated'
          ? (role?.kind === 'ramp' ? T.warning : T.bridge)
          : getPreviewColor();
        return (
          <mesh key={`preview-${i}`} position={[pos.x, 0.2, pos.z]} raycast={() => null}>
            <boxGeometry args={[0.92, 0.4, 0.92]} />
            <meshBasicMaterial color={color} transparent opacity={0.45} depthWrite={false} />
          </mesh>
        );
      })}

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
          // 橋の桁・橋脚は装飾であり選択対象ではない。地面クリックを奪わないよう
          // レイキャストを外す。
          elements.push(
            <group key={`${key}-bridge`}>
              <mesh position={[x, -0.03, z]} castShadow raycast={() => null}>
                <boxGeometry args={[0.72, 0.12, 1.0]} />
                <meshStandardMaterial color="#8a7a68" roughness={0.95} />
              </mesh>
              {[-0.3, 0.3].map(o => (
                <mesh key={o} position={[x + o, -0.18, z]} raycast={() => null}>
                  <boxGeometry args={[0.1, 0.26, 0.16]} />
                  <meshStandardMaterial color="#7b6c5c" roughness={1} />
                </mesh>
              ))}
            </group>
          );
        }
        if (data.tunnel) {
          // トンネルの坑口も装飾であり選択対象ではない。同様にレイキャストを外す。
          elements.push(
            <group key={`${key}-tunnel`}>
              <mesh position={[x, 0.3, z]} castShadow raycast={() => null}>
                <boxGeometry args={[1.0, 0.6, 1.0]} />
                <meshStandardMaterial color="#77726a" roughness={1} flatShading />
              </mesh>
              <mesh position={[x, 0.22, z]} raycast={() => null}>
                <boxGeometry args={[0.56, 0.42, 1.02]} />
                <meshStandardMaterial color="#14181d" roughness={1} />
              </mesh>
            </group>
          );
        }
        return <group key={key}>{elements}</group>;
      })}

      {/* 高架駅セル(upper.stationIdがあるセル)。地平の駅セルと同じStationBlockを
          OVERPASS_HEIGHT分だけ持ち上げて描く。柱の端判定は高架層だけで独立に行う。 */}
      {elevatedCells.map(cell => {
        const data = railMap.get(cell.key);
        if (!data?.uppers?.[1]) return null;
        return (
          <StationBlock
            key={`${cell.key}-elevated`}
            position={[cell.x, OVERPASS_HEIGHT, cell.z]}
            connections={data.uppers[1].connections}
            platformDoors={stations.get(cell.stationId)?.platformDoors ?? 'none'}
            isEnd={elevatedEndKeys.has(cell.key)}
          />
        );
      })}

      <TownBlocks towns={towns} />

      {Array.from(stations.values()).map(station => {
        const orderIndices: number[] = [];
        if (selectedTrain) {
          selectedTrain.schedule.forEach((stId, index) => {
            if (stId === station.id) orderIndices.push(index);
          });
        }
        // 駅舎・ラベルは1駅につき1つだけ出す(立体交差の十字駅でも二重にならないように)。
        // 地平セルがあればそちらを優先して駅舎を置き、無ければ高架セルの位置に置く。
        const ownGroundCells = station.cells.filter(c => (c.layer ?? 0) !== 1);
        const hasElevatedCells = station.cells.some(c => c.layer === 1);
        const cellsForHouse = ownGroundCells.length > 0 ? ownGroundCells : station.cells;
        const centreCell = cellsForHouse[Math.floor(cellsForHouse.length / 2)] ?? station.center;
        const houseIsElevated = ownGroundCells.length === 0;
        const centreConnections = houseIsElevated
          ? railMap.get(toKey(centreCell.x, centreCell.z))?.uppers?.[1]?.connections
          : railMap.get(toKey(centreCell.x, centreCell.z))?.connections;
        const angle = trackAngleFromConnections(centreConnections);
        const houseY = houseIsElevated ? OVERPASS_HEIGHT : 0;
        // 高架ホームを含む駅は、ラベルが高架の上屋にめり込まないようさらに高い位置に出す。
        const labelY = hasElevatedCells ? 1.35 + OVERPASS_HEIGHT : 1.35;
        return (
          <group key={station.id}>
            <StationHouse position={[centreCell.x, houseY, centreCell.z]} angle={angle} />
            <StationLabel station={station} orderIndices={orderIndices} world={world} labelY={labelY} />
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

      {/* 列車ドラッグ中の置き先プレビュー(置ける=緑、置けない=赤。建設プレビューと同じ表現) */}
      {draggingTrainId && cursorPos && (
        <mesh position={[cursorPos.x, 0.2, cursorPos.z]} raycast={() => null}>
          <boxGeometry args={[0.92, 0.4, 0.92]} />
          <meshBasicMaterial
            color={canDropTrainHere ? '#3ddc6f' : REMOVE_COLOUR}
            transparent opacity={0.5} depthWrite={false}
          />
        </mesh>
      )}

      {trains.map(train => (
        <DynamicTrain
          key={train.id} data={train} runtimes={world.current.runtimes} type="commuter"
          isSelected={train.id === selectedTrainId}
          lineColour={findGroup(groups, train.groupId)?.colour}
          onClick={() => {
            if (buildMode !== 'none') return;
            if (justDraggedRef.current) { justDraggedRef.current = false; return; }
            onSelectTrain(train.id);
          }}
          isDragging={draggingTrainId === train.id}
          dragCell={draggingTrainId === train.id ? cursorPos : null}
        />
      ))}
    </>
  );
};
