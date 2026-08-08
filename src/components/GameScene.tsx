// R4d: three.js 全面退役後のゲーム面。描画は1枚の wgpu キャンバス(WebGpuTerrainLayer)が
// 担い、このコンポーネントは
//   1. 入力レイヤー(透明な div)のポインタ/ホイール処理 = カメラ操作とピッキング
//   2. 建設プレビュー・選択状態などのゲーム状態の配線
//   3. wgpu フィーダ群(WebGpu*.tsx)のマウントと、それらに渡す派生値の計算
// だけを受け持つ。three.js のシーングラフ(ライト・地面プレーン・レイキャスト)は無い。
//
// ピッキングは render/picking.ts の閉形式(projectToScreenPx の逆関数)。地形編集モードでは
// 高さ候補を上から走査して「見えているセル」を拾う(旧 TerrainBlocks の pickable 上面
// レイキャストと同じ狙い)。列車クリックは render/trainPicking.ts の画面空間判定。

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  FAR_VIEW_CHUNK_BUDGET, FAR_VIEW_RAIL_CELL_BUDGET, budgetRatio, estimateVisibleChunkCount,
  farViewStageForRatio,
} from '../render/farView';

import { GameLabels } from './GameLabels';
import { WebGpuTrains } from './WebGpuTrains';
import { WebGpuBuildPreview, type PreviewGhostCell } from './WebGpuBuildPreview';
import { WebGpuTownMarkers } from './WebGpuTownMarkers';
import { pickTrainAtScreenPoint, type TrainScreenCandidate } from '../render/trainPicking';
import { carGroupPosition } from '../render/trainInstanceMath';
import type { WebGpuCameraState } from '../render/webgpuCamera';
import {
  MAX_ZOOM, clampZoom, minZoomFor, panByScreenDelta, toWebGpuCameraState, wheelZoomFactor,
  zoomBy, type GameCameraState, type ViewportSize,
} from '../render/cameraState';
import {
  chunkViewFromCamera, clientToScreenPx, pickGroundCell, pickTerrainCell, type ChunkView,
} from '../render/picking';
import { FRAME_ORDER } from '../render/frameLoop';
import { useFrameLoop } from '../hooks/useFrameLoop';
import { SimulationDriver } from './SimulationDriver';
import { WebGpuScenery } from './WebGpuScenery';
import { WebGpuTownBlocks } from './WebGpuTownBlocks';
import { WebGpuTrackNetwork } from './WebGpuTrackNetwork';
import { WebGpuStations } from './WebGpuStations';
import { WebGpuTrackExtras } from './WebGpuTrackExtras';
import { STATION_COLOUR, DEPOT_COLOUR, SIGNAL_COLOUR } from '../types';
import type { CellData, CellType, TrainData, TrainGroupData, StationData, TownData } from '../types';
import { carPositions } from '../sim/consist';
import { toKey, getConstrainedPath } from '../utils';
import type { SimWorld, SimEvent } from '../sim/simulation';
import type { StationAxis, BuildLevel } from '../sim/construction';
import { resolveElevatedPathEnd, pickElevatedConnection, planElevatedPath } from '../sim/construction';
import { isUndergroundView, isLevelDimmed } from '../render/viewMode';
import { canPlaceTrainAt, trainAtCell } from '../sim/relocate';
import { tunnelPortals, elevatedTunnelPortals, buildElevatedTunnelIndex } from '../sim/tunnel';
import type { TerrainField } from '../sim/terrainField';
import { rectCells } from '../sim/terrainOverlay';
import type { TownTileCache } from '../sim/townTiles';
import { townIntersectsCellRange } from '../sim/townTiles';
import { WebGpuRenderDriver, WEBGPU_UNDERGROUND_DIM_FACTOR, type WebGpuLayerRef } from './WebGpuTerrainLayer';
import { T } from '../ui/theme';
import type { BuildMode } from './GameUI';
import { OVERPASS_HEIGHT, MAX_ELEVATED_LEVEL } from '../sim/trackPath';
import {
  groundStationCells, elevatedStationCells, undergroundStationCells, computeStationEndKeys,
  elevatedCellCandidateFromGroundClick, computeStationHousePlacement, type StationHousePlacement,
} from '../render/stationLayers';

const REMOVE_COLOUR = '#ff3b47';

/** 可視チャンク(注視セル・可視半径)の再計算の最短間隔。旧 CameraChunkTracker と同じ。 */
const CHUNK_VIEW_INTERVAL_MS = 150;

/** 中ボタンドラッグ(ドリー)のピクセルあたりのノッチ量。OrbitControls の挙動に合わせる。 */
const DOLLY_PIXELS_TO_NOTCHES = 0.02;

interface GameSceneProps {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  trains: TrainData[];
  towns: TownData[];
  /** 町タイルの遅延キャッシュ(useGameLogicのtownTileIndex)。 */
  townTiles: TownTileCache;
  field: TerrainField;
  /** マップの生成半径(-halfExtent..halfExtent)。可視チャンク・ズーム下限の計算に使う。 */
  halfExtent: number;
  /** wgpu レンダラーのコントローラ(App.tsx が保持)。 */
  webGpuLayer: WebGpuLayerRef;
  /** カメラの真実源(App.tsx が保持、この入力レイヤーが書き換える)。 */
  cameraRef: React.RefObject<GameCameraState>;
  viewportRef: React.RefObject<ViewportSize>;
  /** 直近フレームのカメラ状態の置き場。DOMラベルオーバーレイ(LabelOverlay)が読む。 */
  webGpuCameraStateRef: React.MutableRefObject<WebGpuCameraState | null>;
  world: React.RefObject<SimWorld>;
  buildMode: BuildMode;
  buildLevel: BuildLevel;
  selectedTrainId: string | null;
  isEditingSchedule: boolean;
  simSpeed: number;
  money: number;

  onCommitPath: (
    path: { x: number; z: number }[],
    mode: CellType | 'none' | 'remove' | 'signal' | 'raise' | 'lower',
    stationAxisHint?: StationAxis,
    level?: BuildLevel
  ) => void;
  removeSignal: (x: number, z: number) => void;
  onSimEvent: (event: SimEvent) => void;
  onSelectTrain: (id: string | null) => void;
  onBuyTrain: (x: number, z: number) => void;
  onAddSchedule: (trainId: string, stationId: string) => void;
  onSelectStation: (id: string | null) => void;
  onPreviewChange?: (path: { x: number; z: number }[]) => void;
  groups?: TrainGroupData[];
  onRelocateTrain?: (trainId: string, x: number, z: number) => void;
}

export const GameScene: React.FC<GameSceneProps> = ({
  railMap, stations, trains, towns, townTiles, field, halfExtent, webGpuLayer,
  cameraRef, viewportRef, webGpuCameraStateRef, world, buildMode, buildLevel, selectedTrainId,
  isEditingSchedule, simSpeed,
  onCommitPath, removeSignal, onSimEvent, onSelectTrain, onBuyTrain, onAddSchedule, onSelectStation,
  onPreviewChange, groups = [], onRelocateTrain,
}) => {
  const inputRef = useRef<HTMLDivElement>(null);
  const [chunkView, setChunkView] = useState<ChunkView>({ targetCell: { x: 0, z: 0 }, viewRadiusCells: 24 });
  const [cursorPos, setCursorPos] = useState<{ x: number; z: number } | null>(null);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; z: number } | null>(null);
  // dragStartPos の実体はこの ref に持つ。handlePointerUp が読むのは常にこちら。
  // 理由: pointerdown→pointerup が同期的に(間にpointermoveの再描画が挟まらずに)
  // 発生する「動かさない単発クリック」では、pointerdownのsetDragStartPosがまだ
  // コミットされておらず、pointerup側のクロージャは1つ前の描画時点のdragStartPosを
  // 読んでしまう(地平線路と高架桁が重なる交差セルへの単発クリックで駅が置けなかった
  // 不具合の原因)。stateはプレビュー描画用に残し、コミット判定にはrefを使う。
  const dragStartRef = useRef<{ x: number; z: number } | null>(null);

  // 列車ドラッグ(プラレールを掴んで移動する操作)。押下したセルに列車がいるかを
  // trainAtCell で判定する(列車メッシュ自身のヒットテストには依存しない。
  // 詳細は progress/train-relocate-drag.md 参照)。
  const [trainPress, setTrainPress] = useState<{ id: string; startCell: { x: number; z: number } } | null>(null);
  const [draggingTrainId, setDraggingTrainId] = useState<string | null>(null);
  // ドラッグ確定直後に発生する余計なクリック(=選択解除やクリック選択)を1回だけ無視する。
  const justDraggedRef = useRef(false);

  // 右ドラッグ(パン)・中ドラッグ(ドリー)の進行状態。
  const cameraDragRef = useRef<{ pointerId: number; mode: 'pan' | 'dolly'; lastX: number; lastY: number } | null>(null);

  const terrainEditActive = buildMode === 'raise' || buildMode === 'lower';

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
    // 地形編集は8方向の直線ではなく矩形範囲を選択する(OpenTTD流)。
    if (terrainEditActive) return rectCells(dragStartPos, cursorPos);
    return getConstrainedPath(dragStartPos, cursorPos);
  }, [dragStartPos, cursorPos, buildMode, terrainEditActive]);

  // 高架/地下の線路プレビューの各セルの役割(坂/そのまま)。construction.ts へ問い合わせる
  // (UIにルールを書き写さない)。
  const elevatedPreviewPlan = useMemo(() => {
    if (buildMode !== 'rail' || buildLevel === 0 || previewPath.length < 2) return null;
    const startEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, previewPath[0]), buildLevel);
    const endEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, previewPath[previewPath.length - 1]), buildLevel);
    return planElevatedPath(previewPath.length, startEnd, endEnd, buildLevel);
  }, [buildMode, previewPath, railMap, buildLevel]);

  const undergroundView = isUndergroundView(buildLevel);

  const farViewStage = farViewStageForRatio(
    budgetRatio(estimateVisibleChunkCount(chunkView.viewRadiusCells), FAR_VIEW_CHUNK_BUDGET),
  );
  const farViewHidden = farViewStage === 'hidden';
  const farViewDimmed = farViewStage === 'dimmed';

  // 建設プレビューの内容をUI(コスト・可否の表示)へ流す。
  useEffect(() => {
    onPreviewChange?.(previewPath);
  }, [previewPath, onPreviewChange]);

  // ---- カメラ ---------------------------------------------------------------

  /** いまのカメラ状態(物理ピクセル基準)。ピッキングはフレーム遅れを避けてその場で組む。 */
  const currentCamera = useCallback(
    (): WebGpuCameraState => toWebGpuCameraState(cameraRef.current, viewportRef.current),
    [cameraRef, viewportRef],
  );

  const minZoom = useCallback(
    () => minZoomFor(halfExtent, viewportRef.current.cssWidth, viewportRef.current.cssHeight),
    [halfExtent, viewportRef],
  );

  // 可視チャンクの追跡。カメラが動いたフレームだけ、最短 CHUNK_VIEW_INTERVAL_MS 間隔で
  // 再計算する(旧 CameraChunkTracker のスロットルと同じ意味)。
  const lastChunkRunRef = useRef(0);
  const lastCameraSigRef = useRef('');
  useFrameLoop(FRAME_ORDER.camera, () => {
    const camera = cameraRef.current;
    const viewport = viewportRef.current;
    const signature = `${camera.centreX},${camera.centreZ},${camera.zoom},${viewport.cssWidth},${viewport.cssHeight}`;
    if (signature === lastCameraSigRef.current) return;
    const now = performance.now();
    if (now - lastChunkRunRef.current < CHUNK_VIEW_INTERVAL_MS) return;
    lastChunkRunRef.current = now;
    lastCameraSigRef.current = signature;
    const next = chunkViewFromCamera(currentCamera(), halfExtent);
    setChunkView(prev => (
      prev.targetCell.x === next.targetCell.x
      && prev.targetCell.z === next.targetCell.z
      && prev.viewRadiusCells === next.viewRadiusCells
        ? prev
        : next
    ));
  });

  // ホイールズームはブラウザのスクロールを止める必要があるため、React の合成イベント
  // (passive)ではなく非パッシブなネイティブリスナで登録する。
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const camera = cameraRef.current;
      const next = zoomBy(camera, wheelZoomFactor(event.deltaY), minZoom(), MAX_ZOOM);
      camera.zoom = next.zoom;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [cameraRef, minZoom]);

  // ビューポートが縮んで minZoom が上がった場合に、現在のズームを追従させる。
  useFrameLoop(FRAME_ORDER.camera, () => {
    const camera = cameraRef.current;
    camera.zoom = clampZoom(camera.zoom, minZoom(), MAX_ZOOM);
  });

  // ---- ピッキング -----------------------------------------------------------

  /** ポインタイベントから建設・選択に使うセルを求める(地形編集中は高さを考慮する)。 */
  const cellFromEvent = useCallback((event: React.PointerEvent | React.MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const camera = currentCamera();
    const { sx, sy } = clientToScreenPx(event.clientX, event.clientY, rect, viewportRef.current.dpr);
    return terrainEditActive
      ? pickTerrainCell(camera, sx, sy, field)
      : pickGroundCell(camera, sx, sy);
  }, [currentCamera, viewportRef, terrainEditActive, field]);

  /** 画面空間で列車を拾う(GPU往復なし、render/trainPicking.ts)。 */
  const pickTrainAt = useCallback((event: React.MouseEvent): string | null => {
    const camera = currentCamera();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const cursor = clientToScreenPx(event.clientX, event.clientY, rect, viewportRef.current.dpr);
    const candidates: TrainScreenCandidate[] = [];
    for (const train of trains) {
      if (train.status === 'stored') continue;
      const runtime = world.current?.runtimes.get(train.id);
      if (!runtime) continue;
      const level = runtime.grid.layer ?? 0;
      if (level < 0 && (!undergroundView || level !== buildLevel)) continue;
      const [head] = carPositions(runtime, 1, 1.0, railMap, field);
      if (!head) continue;
      const groupPos = carGroupPosition(head, head.heading);
      candidates.push({ trainId: train.id, worldX: groupPos.x, worldY: groupPos.y, worldZ: groupPos.z });
    }
    return pickTrainAtScreenPoint(candidates, cursor, camera);
  }, [currentCamera, viewportRef, trains, world, undergroundView, buildLevel, railMap, field]);

  // ---- ポインタハンドラ -----------------------------------------------------

  const finishCameraDrag = (event: React.PointerEvent) => {
    const drag = cameraDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return false;
    cameraDragRef.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    return true;
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    // 右ドラッグ=パン / 中ドラッグ=ドリー(旧 OrbitControls の mouseButtons と同じ割当)。
    if (event.button === 2 || event.button === 1) {
      cameraDragRef.current = {
        pointerId: event.pointerId,
        mode: event.button === 2 ? 'pan' : 'dolly',
        lastX: event.clientX,
        lastY: event.clientY,
      };
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;

    if (buildMode === 'none') {
      // 選択モード: 押下したセルに列車がいれば「掴んだ」状態にする(ドラッグ候補)。
      const pos = cellFromEvent(event);
      setCursorPos(pos);
      const trainId = trainAtCell(world.current, pos);
      if (trainId) setTrainPress({ id: trainId, startCell: pos });
      return;
    }
    if (!event.shiftKey) {
      const pos = cellFromEvent(event);
      setCursorPos(pos);
      dragStartRef.current = pos;
      setDragStartPos(pos);
    }
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = cameraDragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      const camera = cameraRef.current;
      if (drag.mode === 'pan') {
        const next = panByScreenDelta(camera, dx, dy);
        camera.centreX = next.centreX;
        camera.centreZ = next.centreZ;
      } else {
        const next = zoomBy(camera, wheelZoomFactor(dy / DOLLY_PIXELS_TO_NOTCHES * 0.01), minZoom(), MAX_ZOOM);
        camera.zoom = next.zoom;
      }
      return;
    }

    const pos = cellFromEvent(event);
    setCursorPos(prev => (prev && prev.x === pos.x && prev.z === pos.z ? prev : pos));
    // 列車を押下したまま別セルへ動いたら、そこでクリック候補からドラッグへ昇格する。
    if (trainPress && !draggingTrainId && (pos.x !== trainPress.startCell.x || pos.z !== trainPress.startCell.z)) {
      setDraggingTrainId(trainPress.id);
    }
  };

  const handlePointerUp = (event: React.PointerEvent) => {
    if (finishCameraDrag(event)) return;
    if (event.button !== 0 && event.type === 'pointerup') return;

    // 選択モードでの列車ドラッグの決着(建設モードのドラッグより先に処理する)。
    if (buildMode === 'none') {
      if (draggingTrainId) {
        const pos = cellFromEvent(event);
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
    if (!start) return;
    const pos = cellFromEvent(event);
    const path = (buildMode === 'station' || buildMode === 'depot' || buildMode === 'signal')
      ? [pos]
      : terrainEditActive
      ? rectCells(start, pos)
      : getConstrainedPath(start, pos);
    // 駅設置(station)は常に単一セルを置くが、ドラッグした向きを軸のヒントとして渡す。
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
  };

  const handlePointerLeave = (event: React.PointerEvent) => {
    handlePointerUp(event);
    setCursorPos(null);
  };

  const handleClick = (event: React.MouseEvent) => {
    // ドラッグ確定直後に来る click は無視する(選択解除・誤選択の防止)。
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    const pos = cellFromEvent(event);

    if (buildMode === 'signal' && event.shiftKey) {
      removeSignal(pos.x, pos.z);
      return;
    }

    if (buildMode !== 'none') return;

    const cell = railMap.get(toKey(pos.x, pos.z));
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
    // 地平にヒットするものが無ければ、等角カメラの見え方から「見えている高架駅セル」の
    // 候補を逆算して確認する(完璧ではないが、高架ホームをクリックして駅を選べる)。
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
    const pickedId = pickTrainAt(event);
    if (pickedId) {
      onSelectTrain(pickedId);
      return;
    }
    onSelectTrain(null);
  };

  // ---- 派生データ(フィーダへ渡す) -----------------------------------------

  const getPreviewColour = () => {
    if (buildMode === 'station') return STATION_COLOUR;
    if (buildMode === 'depot') return DEPOT_COLOUR;
    if (buildMode === 'remove') return REMOVE_COLOUR;
    if (buildMode === 'signal') return SIGNAL_COLOUR;
    if (buildMode === 'raise') return T.terrain;
    if (buildMode === 'lower') return T.warning;
    if (buildMode === 'rail' && buildLevel > 0) return T.bridge;
    return '#3ab6ff';
  };

  // 高架レール(uppers[L])が山岳内部を通る区間の坑口・内部判定。
  const elevatedTunnelIndex = useMemo(
    () => buildElevatedTunnelIndex(railMap, field),
    [railMap, field],
  );
  // 地平の坑口(level:0)+高架の坑口(level:1〜3)を合成する。
  const tunnelPortalList = useMemo(() => {
    const ground = tunnelPortals(railMap, field).map(p => ({ ...p, level: 0 as const }));
    const elevatedLevels: (1 | 2 | 3)[] = Array.from(
      { length: MAX_ELEVATED_LEVEL }, (_, i) => (i + 1) as 1 | 2 | 3,
    );
    const elevated = elevatedLevels.flatMap(level => elevatedTunnelPortals(elevatedTunnelIndex, level));
    return [...ground, ...elevated];
  }, [railMap, field, elevatedTunnelIndex]);

  // 可視チャンク範囲(+1チャンク先読み)に交差する町だけを描画対象にする。
  const TOWN_VISIBLE_MARGIN_CELLS = 32;
  const visibleTowns = useMemo(() => {
    if (farViewHidden) return [];
    const x0 = chunkView.targetCell.x - chunkView.viewRadiusCells - TOWN_VISIBLE_MARGIN_CELLS;
    const x1 = chunkView.targetCell.x + chunkView.viewRadiusCells + TOWN_VISIBLE_MARGIN_CELLS;
    const z0 = chunkView.targetCell.z - chunkView.viewRadiusCells - TOWN_VISIBLE_MARGIN_CELLS;
    const z1 = chunkView.targetCell.z + chunkView.viewRadiusCells + TOWN_VISIBLE_MARGIN_CELLS;
    return towns.filter(t => townIntersectsCellRange(t, x0, x1, z0, z1));
  }, [towns, chunkView, farViewHidden]);

  // 駅セルの層別集計(端判定=上屋の妻側に柱を立てるか)。
  const groundCells = useMemo(() => groundStationCells(railMap), [railMap]);
  const elevatedCells = useMemo(() => elevatedStationCells(railMap), [railMap]);
  const undergroundCells = useMemo(() => undergroundStationCells(railMap), [railMap]);
  const stationEndKeys = useMemo(() => computeStationEndKeys(groundCells), [groundCells]);
  const elevatedEndKeys = useMemo(() => computeStationEndKeys(elevatedCells), [elevatedCells]);
  const undergroundEndKeys = useMemo(() => computeStationEndKeys(undergroundCells), [undergroundCells]);

  // 駅舎の配置(位置・向き・ラベルY)。駅舎メッシュとDOMラベルの両方が使う一次情報源。
  const housePlacements = useMemo(() => {
    const map = new Map<string, StationHousePlacement>();
    if (farViewHidden) return map;
    for (const station of stations.values()) {
      const placement = computeStationHousePlacement(station, railMap, field, undergroundView);
      if (placement) map.set(station.id, placement);
    }
    return map;
  }, [stations, railMap, field, undergroundView, farViewHidden]);

  const previewGhostCells: PreviewGhostCell[] = useMemo(() => previewPath.map((pos, i) => {
    if (buildMode === 'rail' && buildLevel === 0) {
      return { x: pos.x, y: 0.2 + field.cellHeightAt(pos.x, pos.z) * OVERPASS_HEIGHT, z: pos.z, colour: '#3ab6ff' };
    }
    const role = elevatedPreviewPlan?.roles[i];
    const colour = buildMode === 'rail' && buildLevel > 0
      ? (role?.kind === 'ramp' ? T.warning : T.bridge)
      : buildMode === 'rail' && buildLevel < 0
      ? (role?.kind === 'ramp' ? T.warning : T.accent)
      : getPreviewColour();
    const y = buildMode === 'rail' && buildLevel !== 0
      ? 0.2 + (role?.kind === 'ramp' ? role.base : buildLevel) * OVERPASS_HEIGHT
      : buildMode === 'station' && buildLevel !== 0
      ? 0.2 + buildLevel * OVERPASS_HEIGHT
      : (terrainEditActive || buildMode === 'station' || buildMode === 'depot' || buildMode === 'signal')
      ? 0.2 + field.cellHeightAt(pos.x, pos.z) * OVERPASS_HEIGHT
      : 0.2;
    return { x: pos.x, y, z: pos.z, colour };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [previewPath, buildMode, buildLevel, elevatedPreviewPlan, field, terrainEditActive]);

  const dragGhost: PreviewGhostCell | null = (draggingTrainId && cursorPos)
    ? { x: cursorPos.x, y: 0.2, z: cursorPos.z, colour: canDropTrainHere ? '#3ddc6f' : REMOVE_COLOUR }
    : null;

  return (
    <>
      <div
        ref={inputRef}
        data-testid="game-input-layer"
        style={{ position: 'absolute', inset: 0, touchAction: 'none', cursor: buildMode === 'none' ? 'default' : 'crosshair' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerUp}
        onClick={handleClick}
        onContextMenu={(event) => event.preventDefault()}
      />

      <WebGpuRenderDriver
        layerRef={webGpuLayer}
        cameraRef={cameraRef}
        viewportRef={viewportRef}
        dim={isLevelDimmed(0, undergroundView, buildLevel) ? WEBGPU_UNDERGROUND_DIM_FACTOR : 1}
        stateRef={webGpuCameraStateRef}
      />

      <SimulationDriver world={world} onSimEvent={onSimEvent} speed={simSpeed} />

      <WebGpuBuildPreview
        layerRef={webGpuLayer}
        cells={previewGhostCells}
        dragCell={dragGhost}
        gridCentre={buildMode === 'none' ? null : chunkView.targetCell}
      />

      <WebGpuScenery
        layerRef={webGpuLayer}
        field={field}
        railMap={railMap}
        townTiles={townTiles}
        range={halfExtent}
        cameraTargetCell={chunkView.targetCell}
        viewRadiusCells={chunkView.viewRadiusCells}
        dimMultiplier={farViewDimmed ? WEBGPU_UNDERGROUND_DIM_FACTOR : 1}
        hidden={farViewHidden}
      />

      {/* レール・列車は player-built でスパースなため遠景でも基本は表示し続けるが、
          極端に巨大な railMap に対する保険として予算超過時だけ止める。 */}
      {!(farViewHidden && railMap.size > FAR_VIEW_RAIL_CELL_BUDGET) && (
        <WebGpuTrackNetwork
          layerRef={webGpuLayer}
          railMap={railMap}
          field={field}
          undergroundView={undergroundView}
          selectedLevel={buildLevel}
        />
      )}

      <WebGpuStations
        layerRef={webGpuLayer}
        groundCells={groundCells}
        elevatedCells={elevatedCells}
        undergroundCells={undergroundCells}
        stationEndKeys={stationEndKeys}
        elevatedEndKeys={elevatedEndKeys}
        undergroundEndKeys={undergroundEndKeys}
        stations={stations}
        field={field}
        housePlacements={housePlacements}
        undergroundView={undergroundView}
        selectedLevel={buildLevel}
      />
      <WebGpuTrackExtras
        layerRef={webGpuLayer}
        railMap={railMap}
        field={field}
        tunnelPortalList={tunnelPortalList}
      />

      {/* 遠景では1町=詳細メッシュの代わりに1町=1インスタンスのドットへ落とす。 */}
      <WebGpuTownMarkers
        layerRef={webGpuLayer}
        towns={towns}
        field={field}
        cameraRef={cameraRef}
        viewportRef={viewportRef}
        active={farViewHidden}
      />
      <WebGpuTownBlocks
        layerRef={webGpuLayer}
        towns={visibleTowns}
        townTiles={townTiles}
        field={field}
        dimMultiplier={farViewDimmed ? WEBGPU_UNDERGROUND_DIM_FACTOR : 1}
      />

      <GameLabels
        cameraStateRef={webGpuCameraStateRef}
        stations={stations}
        towns={visibleTowns}
        trains={trains}
        selectedTrainId={selectedTrainId}
        world={world}
        field={field}
        housePlacements={housePlacements}
        hidden={farViewHidden}
      />

      <WebGpuTrains
        layerRef={webGpuLayer}
        trains={trains}
        railMap={railMap}
        field={field}
        elevatedTunnelIndex={elevatedTunnelIndex}
        world={world}
        selectedTrainId={selectedTrainId}
        groups={groups}
        undergroundView={undergroundView}
        selectedLevel={buildLevel}
        draggingTrainId={draggingTrainId}
        dragCell={draggingTrainId ? cursorPos : null}
      />
    </>
  );
};
