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
import type { StationAxis, BuildLevel, ElevatedLevel } from '../sim/construction';
import { resolveElevatedPathEnd, pickElevatedConnection, planElevatedPath } from '../sim/construction';
import { canPlaceTrainAt, trainAtCell } from '../sim/relocate';
import { tunnelPortals } from '../sim/tunnel';
import { computeElevation, buildCornerElevationMap, cellCornersFromMap } from '../sim/terrain';
import { TerrainBlocks } from './TerrainBlocks';
import { createGroundTexture } from '../render/groundTexture';
import { computePortalHeadwall, buildHeadwallOutline, buildArchOutline, type Point2D } from '../render/tunnelPortalGeometry';
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
  // ★変更: 線路(rail)・駅(station)ツールの建設対象レベル(0=地平〜MAX_ELEVATED_LEVEL)。
  buildLevel: BuildLevel;
  selectedTrainId: string | null;
  isEditingSchedule: boolean;
  simSpeed: number;
  money: number;

  onCommitPath: (
    path: { x: number; z: number }[],
    mode: CellType | 'none' | 'remove' | 'signal',
    // 駅設置(station)専用: ドラッグ方向から決まる軸のヒント(南北/東西)。
    stationAxisHint?: StationAxis,
    // 線路(rail)・駅(station)専用: 建設対象レベル。省略時は0(地平)。
    level?: BuildLevel
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
  railMap, stations, trains, towns, terrain, world, buildMode, buildLevel, selectedTrainId, isEditingSchedule, simSpeed,
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
    if (buildMode === 'station' || buildMode === 'depot' || buildMode === 'signal') {
      return [cursorPos];
    }
    return getConstrainedPath(dragStartPos, cursorPos);
  }, [dragStartPos, cursorPos, buildMode]);

  // 高架の線路(buildMode==='rail' かつ buildLevel>=1)プレビューの各セルの役割
  // (坂/高架のまま)。construction.tsのresolveElevatedPathEnd/pickElevatedConnection/
  // planElevatedPathにそのまま問い合わせる(UIにルールを書き写さない)。
  const elevatedPreviewPlan = useMemo(() => {
    if (buildMode !== 'rail' || buildLevel === 0 || previewPath.length < 2) return null;
    const level = buildLevel as ElevatedLevel;
    const startEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, previewPath[0]), level);
    const endEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, previewPath[previewPath.length - 1]), level);
    return planElevatedPath(previewPath.length, startEnd, endEnd, level);
  }, [buildMode, previewPath, railMap, buildLevel]);

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
      const path = (buildMode === 'station' || buildMode === 'depot' || buildMode === 'signal')
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
      const level = (buildMode === 'rail' || buildMode === 'station') ? buildLevel : undefined;
      onCommitPath(path, buildMode, stationAxisHint, level);
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
        const elevatedStationId =
          elevatedCell?.uppers?.[1]?.stationId
          ?? elevatedCell?.uppers?.[2]?.stationId
          ?? elevatedCell?.uppers?.[3]?.stationId;
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
    if (buildMode === 'station') return STATION_COLOUR;
    if (buildMode === 'depot') return DEPOT_COLOUR;
    if (buildMode === 'remove') return REMOVE_COLOUR;
    if (buildMode === 'signal') return SIGNAL_COLOUR;
    if (buildMode === 'rail' && buildLevel > 0) return T.bridge;
    return '#3ab6ff';
  };

  const selectedTrain = trains.find(t => t.id === selectedTrainId);

  // トンネルの坑口(山肌に面した出入口)。OpenTTD風にトンネル内部は地形メッシュへ
  // 埋め込む(TerrainBlocks側)ため、坑口だけをこちらで別途描く。行き止まり坑口が
  // 山の内部を突き破らないよう、標高(TerrainBlocksと同じcomputeElevation)を渡す。
  const terrainElevation = useMemo(() => computeElevation(terrain), [terrain]);
  const tunnelPortalList = useMemo(() => tunnelPortals(railMap, terrainElevation), [railMap, terrainElevation]);
  // 坑口の開口を斜面へ沿わせる傾き計算に使うコーナー標高の共有マップ(TerrainBlocksと同じ導出)。
  const terrainCornerMap = useMemo(() => buildCornerElevationMap(terrainElevation), [terrainElevation]);

  // ヘッドウォール(壁)・開口の寸法定数。壁の幅はセル幅いっぱい(1.0)、高さはポータルごとに
  // computePortalHeadwallで決まる。開口はarchRadius===openingHalfWidthとして直線部と半円が
  // 滑らかに繋がるようにしている。
  const wallWidth = 1.0;
  const wallThickness = 0.12;
  const openingHalfWidth = 0.26;
  const openingStraightHeight = 0.26;
  const archRadius = openingHalfWidth;
  // トンネル内部の暗がり(開口断面と同じ形の押し出し)。斜面を突き抜けないよう短く抑える。
  // 0.3ではExtrudeGeometryの奥側キャップ(押し出しの終端の平面)が、見上げるアイソメ
  // カメラでは近い側キャップより画面上で上へずれて投影され、袖壁の高さ(壁の50%)を
  // 越えて壁の脇からはみ出し、開口とは無関係な向きの黒い破片に見える不具合があった
  // (N/S向き坑口で顕著。scene.traverseで奥側キャップの中心を投影し、実際にその位置に
  // 不具合の黒片が一致することを確認した)。奥行きを浅くし、奥側キャップの投影ズレを
  // 袖壁の陰に収まる範囲まで抑える。
  const tunnelMouthDepth = 0.15;

  // ヘッドウォールのジオメトリ(壁+アーチ開口を1枚のExtrudeGeometryとして一体成形)。
  // 「黒い開口パネル+奥の暗箱」を壁の手前に重ねる張りぼて構成だと、斜めから見たときに
  // パネルと暗箱のシルエットが合成されて開口が非対称・不定形に見えてしまっていた
  // (実際に穴が開いていないため輪郭が正しく出ない)。buildHeadwallOutlineで求めた
  // 「壁の外形+アーチ状の切り欠き」を1本の折れ線としてShape化し、実際に穴の開いた壁として
  // 押し出すことで、どの角度から見ても開口の輪郭が正しく読めるようにする。
  // wallHeightはポータルごとに異なるため、高さをキーにジオメトリをキャッシュして使い回す。
  const portalGeometryData = useMemo(() => {
    const cache = new Map<number, THREE.ExtrudeGeometry>();
    return tunnelPortalList.map(portal => {
      const cellCorners = cellCornersFromMap(terrainCornerMap, portal.x, portal.z);
      const { height: wallHeight, embedDepth } = computePortalHeadwall(
        cellCorners, portal.dx, portal.dz, OVERPASS_HEIGHT,
      );
      const cacheKey = Math.round(wallHeight * 1000);
      let headwallGeometry = cache.get(cacheKey);
      if (!headwallGeometry) {
        const outline = buildHeadwallOutline(
          wallWidth, wallHeight, openingHalfWidth, openingStraightHeight, archRadius,
        );
        const shape = new THREE.Shape();
        outline.forEach((p: Point2D, i: number) => (i === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
        shape.closePath();
        headwallGeometry = new THREE.ExtrudeGeometry(shape, { depth: wallThickness, bevelEnabled: false });
        headwallGeometry.translate(0, 0, -wallThickness / 2);
        cache.set(cacheKey, headwallGeometry);
      }
      return { portal, wallHeight, embedDepth, headwallGeometry };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelPortalList, terrainCornerMap]);

  // トンネル内部の暗がりのジオメトリ(開口断面と同形、寸法は固定なので1度だけ生成)。
  const tunnelMouthGeometry = useMemo(() => {
    const outline = buildArchOutline(openingHalfWidth, openingStraightHeight, archRadius);
    const shape = new THREE.Shape();
    outline.forEach((p: Point2D, i: number) => (i === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: tunnelMouthDepth, bevelEnabled: false });
    geometry.translate(0, 0, -tunnelMouthDepth);
    return geometry;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => () => {
    portalGeometryData.forEach(({ headwallGeometry }) => headwallGeometry.dispose());
  }, [portalGeometryData]);
  React.useEffect(() => () => tunnelMouthGeometry.dispose(), [tunnelMouthGeometry]);

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

      {/* 建設プレビュー。高架のrail(buildLevel>=1)は坂になるセルと高架のままのセルを色分けする。 */}
      {previewPath.map((pos, i) => {
        if (buildMode === 'rail' && buildLevel === 0) {
          return <RailBlock key={`preview-${i}`} position={[pos.x, 0.02, pos.z]} isPreview connections={0} />;
        }
        const role = elevatedPreviewPlan?.roles[i];
        const color = buildMode === 'rail' && buildLevel > 0
          ? (role?.kind === 'ramp' ? T.warning : T.bridge)
          : getPreviewColor();
        // 高架のrail/stationは選択中レベルの高さにゴーストを出す。
        // 坂の区間(role.kind==='ramp')は低い側のレベル(role.base)の高さに置く。
        const previewY = buildMode === 'rail' && buildLevel > 0
          ? 0.2 + (role?.kind === 'ramp' ? role.base : buildLevel) * OVERPASS_HEIGHT
          : buildMode === 'station' && buildLevel > 0
          ? 0.2 + buildLevel * OVERPASS_HEIGHT
          : 0.2;
        return (
          <mesh key={`preview-${i}`} position={[pos.x, previewY, pos.z]} raycast={() => null}>
            <boxGeometry args={[0.92, 0.4, 0.92]} />
            <meshBasicMaterial color={color} transparent opacity={0.45} depthWrite={false} />
          </mesh>
        );
      })}

      <TerrainBlocks terrain={terrain} />
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
        return <group key={key}>{elements}</group>;
      })}

      {/* トンネルの坑口(山肌に面した出入口)。OpenTTD風に、斜面の切り口へ石造の垂直な
          ヘッドウォール(正面壁)を立て、中央にアーチ状の暗い開口を設ける。ヘッドウォール
          は境界面よりHEADWALL_EMBED_DEPTHぶん山側へめり込ませて置くことで、斜面との間に
          隙間・浮きが見えないようにする。高さはcomputePortalHeadwallで坑口セルの4隅
          コーナー標高から求め、斜面の切り口を覆うのに十分な高さを確保する。
          壁+開口はbuildHeadwallOutlineで実際に穴を開けた1枚のExtrudeGeometry(portalGeometryData)
          として一体成形しており、黒いパネルを重ねる張りぼてではないため、どの角度から見ても
          開口の輪郭が正しく読める。トンネル内部の暗がりも同じ断面のExtrudeGeometry
          (tunnelMouthGeometry)を壁背面に短く継ぎ足すだけで、斜面を突き抜けない。
          光源が-x側にあるため+x向きの坑口正面が陰りやすく、石壁が真っ黒に潰れないよう
          軽いemissiveを持たせる。左右には山側へ短く延びる袖壁(切り通しを囲う低い壁)を
          添え、壁の外側面にX位置をぴったり合わせて浮いて見えないようにする。
          トンネル内のレールは地表と同じ高さを走るため、開口の基準点は常に地面レベル
          (y=0)に置く(ヘッドウォールは垂直=傾けない)。装飾であり選択対象ではないため
          地面クリックを奪わないよう全meshのレイキャストを外す。 */}
      {portalGeometryData.map(({ portal, wallHeight, embedDepth, headwallGeometry }) => {
        // セル境界面(x+dx*0.5, z+dz*0.5)を基準に置く。
        const faceX = portal.x + portal.dx * 0.5;
        const faceZ = portal.z + portal.dz * 0.5;
        // groupをdx/dz方向(非mountain側)へ向ける。ローカル+Zがこの方向に一致する
        // (=局所+Zが坑口の外向き=手前側、局所-Zが山の内側=奥)。
        const angle = Math.atan2(portal.dx, portal.dz);

        const wallZ = -embedDepth; // 境界面からわずかに山側(-Z)へめり込ませる。
        const wallFrontZ = wallZ + wallThickness / 2; // 壁の手前側の面(局所+Z側)。
        const backFaceZ = wallZ - wallThickness / 2; // 壁の奥側の面(局所-Z側、山の内部)。
        // 笠石(コーピング)。壁天端に幅+奥行きをやや張り出させる。壁よりわずかに濃い
        // トーンにして輪郭が出るようにする。
        const copingWidth = wallWidth + 0.1;
        const copingThickness = wallThickness + 0.06;
        const copingHeight = 0.08;
        // 袖壁(切り通しを囲う低い壁)。壁の手前側の面から山側(-Z)へだけ短く延ばし、
        // 高さは壁の半分以下・笠石より必ず低くする。X位置は壁の外側面にぴったり揃えて
        // (壁からはみ出て浮いて見えないよう)壁の内側に収める。
        const sleeveDepth = 0.35;
        const sleeveThickness = 0.1;
        const sleeveHeight = wallHeight * 0.5;
        const sleeveX = wallWidth / 2 - sleeveThickness / 2;

        return (
          <group
            key={`portal-${portal.x},${portal.z},${portal.dx},${portal.dz}`}
            position={[faceX, 0, faceZ]}
            rotation-y={angle}
          >
            {/* ヘッドウォール本体(壁+アーチ開口を一体成形)。陰でも石壁として読めるよう
                軽いemissiveを持たせる。ExtrudeGeometryの巻き順に依存せず両面から正しく
                見えるようdoubleSideにする。 */}
            <mesh geometry={headwallGeometry} position={[0, 0, wallZ]} castShadow raycast={() => null}>
              <meshStandardMaterial
                color="#a2a7ae" roughness={1} emissive="#3a3e44" emissiveIntensity={0.35} side={THREE.DoubleSide}
              />
            </mesh>
            {/* 左右の袖壁。壁の手前側の面から山側(-Z)へ短く延びる。 */}
            {[-1, 1].map(side => (
              <mesh
                key={`sleeve-${side}`}
                position={[side * sleeveX, sleeveHeight / 2, wallFrontZ - sleeveDepth / 2]}
                castShadow
                raycast={() => null}
              >
                <boxGeometry args={[sleeveThickness, sleeveHeight, sleeveDepth]} />
                <meshStandardMaterial color="#a2a7ae" roughness={1} emissive="#3a3e44" emissiveIntensity={0.35} />
              </mesh>
            ))}
            {/* 天端の笠石。壁よりひとまわり張り出し、わずかに濃いトーンで輪郭を出す。 */}
            <mesh position={[0, wallHeight + copingHeight / 2, wallZ]} castShadow raycast={() => null}>
              <boxGeometry args={[copingWidth, copingHeight, copingThickness]} />
              <meshStandardMaterial color="#8b9097" roughness={1} emissive="#2c2f33" emissiveIntensity={0.3} />
            </mesh>
            {/* トンネル内部の暗がり。開口と同じ断面形状(アーチ)を壁背面から短く押し出し、
                覗き込んでも中が透けないようにする。断面が開口と同形なので壁の輪郭からは
                み出ず、長い箱と違って斜面を突き抜けない。
                側面をDoubleSideにすると、山側の奥まった面(押し出しの終端キャップ)が
                斜面に覆われず露出する角度で、開口とは無関係な向きの黒い断片として
                見えてしまう不具合があった(N/S向き坑口で顕著)。FrontSide(既定)にし、
                カメラに背を向ける終端キャップは通常のバックフェースカリングで隠す。 */}
            <mesh geometry={tunnelMouthGeometry} position={[0, 0, backFaceZ]} raycast={() => null}>
              <meshStandardMaterial color="#0b0e12" roughness={1} />
            </mesh>
          </group>
        );
      })}

      {/* 高架駅セル(uppers[L].stationIdがあるセル)。地平の駅セルと同じStationBlockを
          レベルLぶん(L*OVERPASS_HEIGHT)持ち上げて描く。柱の端判定は高架層だけで独立に行う。 */}
      {elevatedCells.map(cell => {
        const level = cell.level ?? 1;
        return (
          <StationBlock
            key={`${cell.key}-elevated`}
            position={[cell.x, level * OVERPASS_HEIGHT, cell.z]}
            connections={cell.connections}
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
        // 地平セルがあればそちらを優先して駅舎を置き、無ければ最も低い高架レベルの位置に置く。
        const ownGroundCells = station.cells.filter(c => !c.layer);
        const elevatedLevels = station.cells.map(c => c.layer).filter((l): l is 1 | 2 | 3 => !!l);
        const hasElevatedCells = elevatedLevels.length > 0;
        const houseIsElevated = ownGroundCells.length === 0;
        // 駅舎を置く高架レベル(地平セルが無いときのみ使う)。複数レベルにまたがる駅では
        // 一番低いレベルに駅舎を置く(見た目上、地平に近い側のほうが自然なため)。
        const houseLevel = houseIsElevated ? Math.min(...elevatedLevels) as 1 | 2 | 3 : 1;
        const cellsForHouse = houseIsElevated
          ? station.cells.filter(c => c.layer === houseLevel)
          : ownGroundCells;
        const centreCell = cellsForHouse[Math.floor(cellsForHouse.length / 2)] ?? station.center;
        const centreConnections = houseIsElevated
          ? railMap.get(toKey(centreCell.x, centreCell.z))?.uppers?.[houseLevel]?.connections
          : railMap.get(toKey(centreCell.x, centreCell.z))?.connections;
        const angle = trackAngleFromConnections(centreConnections);
        const houseY = houseIsElevated ? houseLevel * OVERPASS_HEIGHT : 0;
        // 高架ホームを含む駅は、ラベルが高架の上屋にめり込まないよう、最も高いレベルに
        // 合わせてさらに高い位置に出す。
        const labelY = hasElevatedCells ? 1.35 + Math.max(...elevatedLevels) * OVERPASS_HEIGHT : 1.35;
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
          key={train.id} data={train} railMap={railMap} runtimes={world.current.runtimes} type="commuter"
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
