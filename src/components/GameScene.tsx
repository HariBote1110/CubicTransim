import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import {
  FAR_VIEW_CHUNK_BUDGET, FAR_VIEW_RAIL_CELL_BUDGET, budgetRatio, estimateVisibleChunkCount,
  farViewStageForRatio,
} from '../render/farView';
import { minZoomForFullMap, orthographicNearFarForHalfExtent } from '../render/webgpuCamera';
import { TownMarkers } from './TownMarkers';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

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
import type { CellData, CellType, TrainData, TrainGroupData, StationData, TownData, Level } from '../types';
import { findGroup } from '../sim/groups';
import { toKey, fromKey, getConstrainedPath } from '../utils';
import type { SimWorld, SimEvent } from '../sim/simulation';
import type { StationAxis, BuildLevel } from '../sim/construction';
import { resolveElevatedPathEnd, pickElevatedConnection, planElevatedPath } from '../sim/construction';
import { isUndergroundView, isLevelDimmed, SURFACE_RENDER_ORDER, UNDERGROUND_RENDER_ORDER } from '../render/viewMode';
import { canPlaceTrainAt, trainAtCell } from '../sim/relocate';
import { tunnelPortals, elevatedTunnelPortals, buildElevatedTunnelIndex } from '../sim/tunnel';
import type { TerrainField } from '../sim/terrainField';
import { rectCells, type CornerDiffs } from '../sim/terrainOverlay';
import type { TownTileCache } from '../sim/townTiles';
import { townIntersectsCellRange } from '../sim/townTiles';
import { TerrainBlocks } from './TerrainBlocks';
import { WebGpuCameraSync, WEBGPU_UNDERGROUND_DIM_FACTOR, type WebGpuLayerRef } from './WebGpuTerrainLayer';
import { createGroundTexture } from '../render/groundTexture';
import {
  computePortalHeadwall, buildHeadwallOutline, buildArchOutline, type Point2D,
  PORTAL_WALL_WIDTH, PORTAL_WALL_THICKNESS, PORTAL_BODY_DEPTH, PORTAL_MOUTH_CAP_DEPTH,
} from '../render/tunnelPortalGeometry';
import { T } from '../ui/theme';
import type { BuildMode } from './GameUI';
import { OVERPASS_HEIGHT, MAX_ELEVATED_LEVEL } from '../sim/trackPath';
import {
  groundStationCells, elevatedStationCells, undergroundStationCells, computeStationEndKeys,
  elevatedCellCandidateFromGroundClick,
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

/**
 * カメラの可視範囲(注視点セル座標＋可視半径セル数)をTerrainBlocks/Sceneryの
 * チャンク描画へ渡すための追跡コンポーネント。
 *
 * 直交カメラの4隅(NDCの±1)をy=0平面へ逆投影し、その外接矩形の中心・半径を
 * 可視範囲として使う(design memo P4 pt.3)。毎フレーム計算せず、OrbitControlsの
 * 'change'イベント(パン・ズーム操作)だけを起点にし、さらに間引く(最短でも
 * UPDATE_INTERVAL_MSごと)ことで、チャンク集合の更新頻度を「操作のたびに数回」に
 * 抑える。
 */
const UPDATE_INTERVAL_MS = 150;

interface ChunkView {
  targetCell: { x: number; z: number };
  viewRadiusCells: number;
}

const CameraChunkTracker: React.FC<{
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  onChange: (view: ChunkView) => void;
  /**
   * R3: 可視半径(セル数)の上限。カメラの見え方の逆投影は理論上どこまでも大きくなり得るが、
   * マップ自体の半径(halfExtent)より広い可視半径を追跡しても意味が無い上、WebGPUモードで
   * 全図ズームアウトした際にこの値が下流(Scenery等のチャンク列挙見積もり)へそのまま渡ると
   * 過大評価の温床になる。ここで一度クランプしておくことで、下流のガード(render/farView.ts)
   * が現実的な値だけを扱えばよくなる。省略時はクランプしない(既存の呼び出し互換)。
   */
  maxViewRadiusCells?: number;
}> = ({ controlsRef, onChange, maxViewRadiusCells }) => {
  const { camera } = useThree();
  const lastRunRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const computeAndEmit = useCallback(() => {
    const near = new THREE.Vector3();
    const far = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const ground = new THREE.Vector3();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

    for (const ndcX of [-1, 1]) {
      for (const ndcY of [-1, 1]) {
        near.set(ndcX, ndcY, -1).unproject(camera);
        far.set(ndcX, ndcY, 1).unproject(camera);
        dir.subVectors(far, near);
        if (Math.abs(dir.y) < 1e-6) continue;
        const t = -near.y / dir.y;
        ground.copy(near).addScaledVector(dir, t);
        minX = Math.min(minX, ground.x);
        maxX = Math.max(maxX, ground.x);
        minZ = Math.min(minZ, ground.z);
        maxZ = Math.max(maxZ, ground.z);
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;

    const rawRadius = Math.ceil(Math.max(maxX - minX, maxZ - minZ) / 2);
    onChange({
      targetCell: { x: Math.round((minX + maxX) / 2), z: Math.round((minZ + maxZ) / 2) },
      viewRadiusCells: maxViewRadiusCells !== undefined ? Math.min(rawRadius, maxViewRadiusCells) : rawRadius,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, onChange, maxViewRadiusCells]);

  useEffect(() => {
    // 初期表示ぶんは即座に計算する。
    computeAndEmit();

    const scheduleUpdate = () => {
      const now = performance.now();
      const elapsed = now - lastRunRef.current;
      if (timerRef.current) return; // 既に予約済みならまとめる(スロットル)。
      const delay = Math.max(0, UPDATE_INTERVAL_MS - elapsed);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        lastRunRef.current = performance.now();
        computeAndEmit();
      }, delay);
    };

    const controls = controlsRef.current;
    controls?.addEventListener('change', scheduleUpdate);
    return () => {
      controls?.removeEventListener('change', scheduleUpdate);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [controlsRef, computeAndEmit]);

  return null;
};

interface GameSceneProps {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  trains: TrainData[];
  towns: TownData[];
  /**
   * 町タイルの遅延キャッシュ(useGameLogicのtownTileIndex)。樹木の間引き・建設ガードに
   * 使うほか、subTilesForTownsで可視町だけの描画用サブタイルを取り出す(P5、下記参照)。
   */
  townTiles: TownTileCache;
  field: TerrainField;
  /** マップの生成半径(-halfExtent..halfExtent)。Scenery/TerrainBlocksの走査範囲に使う。 */
  halfExtent: number;
  /** 地形編集の疎な差分(useGameLogicのcornerDiffs)。TerrainBlocksのチャンクキャッシュ無効化に使う。 */
  cornerDiffs?: CornerDiffs;
  /**
   * WebGPUモード(二層合成)のとき、下層キャンバスのコントローラ。渡されている間は
   * 地形を下層(wgpu)が描くため、TerrainBlocksをアンマウントし、地面プレーンの
   * 色出力も止める(ポインタ判定用にメッシュ自体は残す)。
   */
  webGpuLayer?: WebGpuLayerRef;
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
    mode: CellType | 'none' | 'remove' | 'signal' | 'raise' | 'lower',
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
  railMap, stations, trains, towns, townTiles, field, halfExtent, cornerDiffs, webGpuLayer, world, buildMode, buildLevel, selectedTrainId, isEditingSchedule, simSpeed,
  onCommitPath, removeSignal, onSimEvent, onSelectTrain, onBuyTrain, onAddSchedule, onSelectStation,
  onPreviewChange, groups = [], onRelocateTrain,
}) => {
  // カメラの可視範囲(チャンク描画の中心・半径)。既定値は原点周辺(初期カメラの見え方に
  // 近い半径)にしておき、CameraChunkTrackerが初回描画後すぐに実測値へ更新する。
  const [chunkView, setChunkView] = useState<ChunkView>({ targetCell: { x: 0, z: 0 }, viewRadiusCells: 24 });
  const orbitControlsRef = useRef<OrbitControlsImpl | null>(null);
  // R3: ビューポートのCSSピクセルサイズ(minZoom計算に使う。DPR非依存、webgpuCamera.ts参照)。
  const { size: viewportSize } = useThree();
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

  // 地形編集(盛土/切土)モードか。選択はOpenTTD風の矩形ドラッグになり、
  // 地形メッシュ(TerrainBlocks)を直接ポインタで拾えるようにする。
  const terrainEditActive = buildMode === 'raise' || buildMode === 'lower';

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

  // 高架の線路(buildMode==='rail' かつ buildLevel>=1)プレビューの各セルの役割
  // (坂/高架のまま)。construction.tsのresolveElevatedPathEnd/pickElevatedConnection/
  // planElevatedPathにそのまま問い合わせる(UIにルールを書き写さない)。
  const elevatedPreviewPlan = useMemo(() => {
    if (buildMode !== 'rail' || buildLevel === 0 || previewPath.length < 2) return null;
    // pickElevatedConnection/planElevatedPathはlevelの符号に対称(P8a)なので、
    // 地下(buildLevel<0)もそのまま同じ呼び出しでプレビュー計画が求まる。
    const startEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, previewPath[0]), buildLevel);
    const endEnd = pickElevatedConnection(resolveElevatedPathEnd(railMap, previewPath[previewPath.length - 1]), buildLevel);
    return planElevatedPath(previewPath.length, startEnd, endEnd, buildLevel);
  }, [buildMode, previewPath, railMap, buildLevel]);

  // P8b: 地下ビュー(地平・高架を暗く半透明にし、選択中の地下レベルだけ通常輝度で描く)。
  // buildLevelが負のときに入る(GameUIのArrowUp/Downで地下側へ切り替えると連動する)。
  const undergroundView = isUndergroundView(buildLevel);

  // R3: WebGPUモードのみ、全図ズームアウトを解禁するためminZoomをマップ全体が画面に
  // 収まる値まで下げる(render/webgpuCamera.tsのminZoomForFullMap、renderer_wgpuの
  // full_map_min_ppcと同じ式)。従来モードは既存の固定値のまま(3D three.jsチャンク
  // 描画が全図規模だと重すぎるため、そもそも解禁しない)。
  // 巨大マップ(halfExtent=8192)ではminZoomForFullMapが1よりずっと小さい値(0.05前後)に
  // なるのが正しい(全図を収めるには広く引く必要があるため)。floorは「0や負値にならない」
  // ための最低限の安全弁に留め、1のような大きな値でクランプしてしまわないようにする。
  const minZoom = webGpuLayer
    ? Math.max(0.001, minZoomForFullMap(halfExtent, viewportSize.width, viewportSize.height))
    : 20;

  // R3: 遠景(全図ズームアウト)でのオーバーレイの扱い。WebGPUモードのときだけ、可視半径
  // (chunkView.viewRadiusCells)からチャンク列挙予算に対する近さを求め、3段階
  // (normal/dimmed/hidden)にマップする(render/farView.ts参照)。従来モードはズーム上限が
  // 変わらず可視半径が元々小さいままなので常にnormal。
  const farViewStage = webGpuLayer
    ? farViewStageForRatio(budgetRatio(estimateVisibleChunkCount(chunkView.viewRadiusCells), FAR_VIEW_CHUNK_BUDGET))
    : 'normal';
  const farViewHidden = farViewStage === 'hidden';
  const farViewDimmed = farViewStage === 'dimmed';

  // R3: TownMarkers(遠景の町ドット、下記)はカメラのtarget位置に関係なくマップ全域の点を
  // 一括で描くため、target から離れた点ほど視線方向への深度が大きくなり、元々
  // 小さいマップ用に決め打ちしていたnear/far(-50/200)ではマップの一部がクリップされて
  // 消えてしまう(render/webgpuCamera.tsのorthographicNearFarForHalfExtent参照)。
  // halfExtentに応じて広げておく(小さいマップでは実質ノーコスト)。
  const { near: cameraNear, far: cameraFar } = orthographicNearFarForHalfExtent(halfExtent);

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
        : terrainEditActive
        ? rectCells(start, pos)
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
    if (buildMode === 'raise') return T.terrain;
    if (buildMode === 'lower') return T.warning;
    if (buildMode === 'rail' && buildLevel > 0) return T.bridge;
    return '#3ab6ff';
  };

  const selectedTrain = trains.find(t => t.id === selectedTrainId);

  // トンネルの坑口(山肌に面した出入口)。OpenTTD風にトンネル内部は地形メッシュへ
  // 埋め込む(TerrainBlocks側)ため、坑口だけをこちらで別途描く。行き止まり坑口が
  // 山の内部を突き破らないよう、地形field(コーナー標高)を直接クエリする。
  // 高架レール(uppers[L])が山岳内部を通る区間の坑口・内部判定(sim/tunnel.tsの
  // buildElevatedTunnelIndex)。4隅すべての標高がそのレベル以上のセルだけを内部と
  // みなすことで、坑口の箱が斜面から浮く/背後・左右に隙間ができる不具合を防ぐ。
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

  // ヘッドウォール(壁)・開口の寸法定数。壁の幅はセル幅いっぱい(1.0)、高さはポータルごとに
  // computePortalHeadwallで決まる。開口はarchRadius===openingHalfWidthとして直線部と半円が
  // 滑らかに繋がるようにしている。
  const wallWidth = PORTAL_WALL_WIDTH;
  const wallThickness = PORTAL_WALL_THICKNESS;
  const openingHalfWidth = 0.26;
  const openingStraightHeight = 0.26;
  const archRadius = openingHalfWidth;
  // トンネル内部の暗がりの板厚(見た目上ごくわずかで良い。0扱いにはせず、z-fightingを
  // 避ける最小限の厚みを持たせる)。
  const tunnelMouthPlateDepth = PORTAL_MOUTH_CAP_DEPTH;
  // ヘッドウォール背後に接続する、穴の無い中実な箱状ボディの奥行き。
  const bodyDepth = PORTAL_BODY_DEPTH;

  // ヘッドウォールのジオメトリ(壁+アーチ開口を1枚のExtrudeGeometryとして一体成形、
  // 深さは壁厚のみ)。以前は「壁+ボディ」をまとめて1本のExtrudeGeometryとして
  // アーチ穴ごと押し出していたが、これだとボディ側にもアーチ型のトンネルが貫通してしまい、
  // 山側(裏)の面にもアーチ形の穴が開いて、その奥の黒キャップが裏面の黒いアーチとして
  // 露出する不具合があった。ヘッドウォールは壁厚(wallThickness)ぶんだけ穴あきで押し出し、
  // その背後には穴の無い中実なボディ(boxGeometry)を密着させる「穴あき前壁+中実ボディ」
  // 構成に変更し、穴が壁の中でだけ完結して裏まで貫通しないようにする。
  // wallHeightはポータルごとに異なるため、高さをキーにジオメトリをキャッシュして使い回す。
  const portalGeometryData = useMemo(() => {
    const cache = new Map<number, THREE.ExtrudeGeometry>();
    return tunnelPortalList.map(portal => {
      const cellCorners = field.cellCornerHeights(portal.x, portal.z);
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
  }, [tunnelPortalList, field]);

  // トンネル内部の暗がりのジオメトリ(開口断面と同形の薄い平板。壁の背面に面一で
  // 貼り付ける終端キャップ。寸法は固定なので1度だけ生成する)。
  const tunnelMouthGeometry = useMemo(() => {
    const outline = buildArchOutline(openingHalfWidth, openingStraightHeight, archRadius);
    const shape = new THREE.Shape();
    outline.forEach((p: Point2D, i: number) => (i === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: tunnelMouthPlateDepth, bevelEnabled: false });
    geometry.translate(0, 0, -tunnelMouthPlateDepth);
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

  // 地面プレーン(ポインタ判定・装飾テクスチャ)の一辺長と中心。
  // halfExtentが小さい通常マップ(既定45)ではプレーンが原点固定のままマップ全域を
  // 覆えるため従来通り。halfExtentが大きい(16K級)マップでは、マップ全域を1枚の
  // プレーンで覆うと巨大な平面ジオメトリ・巨大なポインタ判定範囲になってしまうため、
  // カメラの注視チャンク(32セル単位にスナップ)へ追従させ、可視範囲を十分覆う
  // 一定サイズ(GROUND_PLANE_SPAN)だけを描く。スナップにより、CameraChunkTrackerの
  // スロットル更新のたびに再配置が起きるのを防ぐ(32セル動くまでは再配置しない)。
  const GROUND_PLANE_SPAN = 320;
  const groundFitsWholeMap = 2 * halfExtent + 40 <= GROUND_PLANE_SPAN;
  const groundSpan = groundFitsWholeMap ? Math.max(140, 2 * halfExtent + 40) : GROUND_PLANE_SPAN;
  const groundCentre = groundFitsWholeMap
    ? { x: 0, z: 0 }
    : {
      x: Math.round(chunkView.targetCell.x / 32) * 32,
      z: Math.round(chunkView.targetCell.z / 32) * 32,
    };

  // ★追加(P5): 可視チャンク範囲(+1チャンク先読み)に交差する町だけを描画対象にする
  // (TerrainBlocks/Sceneryと同じchunkViewを再利用)。TownTileCache.subTilesForTownsは
  // クエリした町だけを遅延生成するため、マップ全体の町数に関わらず可視町ぶんのコストで済む。
  const TOWN_VISIBLE_MARGIN_CELLS = 32; // 1チャンク(TERRAIN_CHUNK_SIZE)ぶんの先読み
  // R3: 遠景(farViewHidden)では、ほぼ全町が「可視」になり得るため、この可視町抽出も
  // 詳細サブタイル生成(subTilesForTowns、1町あたり数十〜数百メッシュ)も行わない。
  // 遠景では代わりにTownMarkers(全townsを1インスタンスメッシュで描く安価な代替表現)を使う。
  const visibleTowns = useMemo(() => {
    if (farViewHidden) return [];
    const x0 = chunkView.targetCell.x - chunkView.viewRadiusCells - TOWN_VISIBLE_MARGIN_CELLS;
    const x1 = chunkView.targetCell.x + chunkView.viewRadiusCells + TOWN_VISIBLE_MARGIN_CELLS;
    const z0 = chunkView.targetCell.z - chunkView.viewRadiusCells - TOWN_VISIBLE_MARGIN_CELLS;
    const z1 = chunkView.targetCell.z + chunkView.viewRadiusCells + TOWN_VISIBLE_MARGIN_CELLS;
    return towns.filter(t => townIntersectsCellRange(t, x0, x1, z0, z1));
  }, [towns, chunkView, farViewHidden]);
  const visibleTownSubTiles = useMemo(
    () => townTiles.subTilesForTowns(visibleTowns.map(t => t.id)),
    [townTiles, visibleTowns]
  );

  // 駅セルがホームの端かどうか(=同一stationIdの隣接セルが1つ以下)を判定する。
  // 端のセルだけ上屋の妻側にも柱を立てて、ホームが尻切れに見えないようにする。
  // 地平・高架は別の層として独立に集計する(render/stationLayers.ts参照)。
  const groundCells = useMemo(() => groundStationCells(railMap), [railMap]);
  const elevatedCells = useMemo(() => elevatedStationCells(railMap), [railMap]);
  const undergroundCells = useMemo(() => undergroundStationCells(railMap), [railMap]);
  const stationEndKeys = useMemo(() => computeStationEndKeys(groundCells), [groundCells]);
  const elevatedEndKeys = useMemo(() => computeStationEndKeys(elevatedCells), [elevatedCells]);
  const undergroundEndKeys = useMemo(() => computeStationEndKeys(undergroundCells), [undergroundCells]);

  return (
    <>
      <hemisphereLight args={['#dcefff', '#75825a', 0.55]} />
      <ambientLight intensity={0.2} />
      <SunLight />
      <OrthographicCamera
        makeDefault position={[20, 20, 20]} zoom={40} near={cameraNear} far={cameraFar}
        ref={(cam) => { if (cam) (window as any).__camera = cam; }}
      />
      <OrbitControls
        ref={(c) => { orbitControlsRef.current = c; if (c) (window as any).__orbitControls = c; }}
        makeDefault
        enableRotate={false}
        enableZoom={true}
        minZoom={minZoom}
        maxZoom={100}
        mouseButtons={{ LEFT: undefined as any, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
      />
      <CameraChunkTracker controlsRef={orbitControlsRef} onChange={setChunkView} maxViewRadiusCells={halfExtent} />

      {/* 建設プレビュー。高架のrail(buildLevel>=1)は坂になるセルと高架のままのセルを色分けする。 */}
      {previewPath.map((pos, i) => {
        if (buildMode === 'rail' && buildLevel === 0) {
          // 地平の線路プレビュー(P7c): incline/tunnelでの低い側/高い側の描き分けまでは
          // 建設可否確定前のプレビューでは行わず、セルの代表標高(cellHeightAt)へ
          // シンプルに乗せるだけにする(design memo「keep it simple」)。
          const railY = 0.02 + field.cellHeightAt(pos.x, pos.z) * OVERPASS_HEIGHT;
          return <RailBlock key={`preview-${i}`} position={[pos.x, railY, pos.z]} isPreview connections={0} />;
        }
        const role = elevatedPreviewPlan?.roles[i];
        // P8b: 地下(buildLevel<0)のプレビューは高架と同じroleの色分けを使い回すが、
        // 地下らしい差し色(warning系ではなくaccent寄り)にする。
        const color = buildMode === 'rail' && buildLevel > 0
          ? (role?.kind === 'ramp' ? T.warning : T.bridge)
          : buildMode === 'rail' && buildLevel < 0
          ? (role?.kind === 'ramp' ? T.warning : T.accent)
          : getPreviewColor();
        // 高架/地下のrail/stationは選択中レベルの高さにゴーストを出す。
        // 坂の区間(role.kind==='ramp')は低い側のレベル(role.base)の高さに置く。
        const previewY = buildMode === 'rail' && buildLevel !== 0
          ? 0.2 + (role?.kind === 'ramp' ? role.base : buildLevel) * OVERPASS_HEIGHT
          : buildMode === 'station' && buildLevel !== 0
          ? 0.2 + buildLevel * OVERPASS_HEIGHT
          // 地形編集・地平の駅/車庫/信号プレビューはセルの現在の標高の上にゴーストを
          // 重ねる(丘の上でも埋もれない)。
          : (terrainEditActive || buildMode === 'station' || buildMode === 'depot' || buildMode === 'signal')
          ? 0.2 + field.cellHeightAt(pos.x, pos.z) * OVERPASS_HEIGHT
          : 0.2;
        return (
          <mesh key={`preview-${i}`} position={[pos.x, previewY, pos.z]} raycast={() => null}>
            <boxGeometry args={[0.92, 0.4, 0.92]} />
            <meshBasicMaterial color={color} transparent opacity={0.45} depthWrite={false} />
          </mesh>
        );
      })}

      {/* 地形編集モード中は地形メッシュ自体をポインタで拾い、丘の上でもe.pointが
          実際の地表(=真上のセル)に当たるようにする。地面プレーン(y=0)だけだと、
          直交カメラの見え方のずれで高い地形の頂上をクリックしても手前のセルが選ばれて
          しまうため。ハンドラ内でstopPropagationし、背後の地面プレーンのハンドラが
          プレーン上の(ずれた)e.pointで二重に発火しないようにする。 */}
      {webGpuLayer && (
        <WebGpuCameraSync
          layerRef={webGpuLayer}
          controlsRef={orbitControlsRef}
          dim={isLevelDimmed(0, undergroundView, buildLevel) ? WEBGPU_UNDERGROUND_DIM_FACTOR : 1}
        />
      )}

      {/* WebGPUモードでは地形は下層(wgpu)が描くので、three.js側の地形メッシュは出さない。 */}
      {!webGpuLayer && (
      <TerrainBlocks
        field={field}
        halfExtent={halfExtent}
        diffs={cornerDiffs}
        cameraTargetCell={chunkView.targetCell}
        viewRadiusCells={chunkView.viewRadiusCells}
        pickable={terrainEditActive}
        onPointerMove={(e) => { e.stopPropagation(); handlePointerMove(e); }}
        onPointerDown={handlePointerDown}
        onPointerUp={(e) => { e.stopPropagation(); handlePointerUp(e); }}
        dimmed={undergroundView}
      />
      )}
      {/* R3: 遠景(farViewHidden)では樹木そのものを列挙しない(render/farView.ts参照、
          hidden propが立つとvisibleChunkRangeを呼ばない)。dimmed段階では既存の
          DIMMED_MATERIALS機構を再利用して唐突に消えないフェード感を出す。 */}
      <Scenery
        field={field}
        railMap={railMap}
        townTiles={townTiles}
        range={halfExtent}
        cameraTargetCell={chunkView.targetCell}
        viewRadiusCells={chunkView.viewRadiusCells}
        dimmed={undergroundView || farViewDimmed}
        hidden={farViewHidden}
      />
      {/* R3: レール・列車は player-built でスパースなため遠景でも基本は表示し続けるが、
          極端に巨大なrailMapに対する保険としてFAR_VIEW_RAIL_CELL_BUDGETを超える場合だけ
          遠景で描画を止める。 */}
      {!(farViewHidden && railMap.size > FAR_VIEW_RAIL_CELL_BUDGET) && (
        <TrackNetwork railMap={railMap} field={field} undergroundView={undergroundView} selectedLevel={buildLevel} />
      )}

      {Array.from(railMap.entries()).map(([key, data]) => {
        const { x, z } = fromKey(key);
        const elements = [];
        // 駅・車庫・信号はflatセル限定(P7a)なので、単一のセル標高(cellHeightAt)を
        // そのまま持ち上げに使える(inclineのような低い側/高い側の使い分けは不要)。
        const groundY = field.cellHeightAt(x, z) * OVERPASS_HEIGHT;
        if (data.type === 'station') {
          elements.push(
            <StationBlock
              key={key}
              position={[x, groundY, z]}
              connections={data.connections}
              platformDoors={stations.get(data.stationId ?? '')?.platformDoors ?? 'none'}
              isEnd={stationEndKeys.has(key)}
              dimmed={isLevelDimmed(0, undergroundView, buildLevel)}
            />
          );
        } else if (data.type === 'depot') {
           elements.push(<DepotBlock key={key} position={[x, groundY, z]} rotation={data.rotation} />);
        }
        if (data.signalDir) {
           elements.push(<SignalBlock key={`${key}-sig`} position={[x, groundY + 0.05, z]} dir={data.signalDir} />);
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

      {/* トンネルの坑口(山肌に面した出入口)。OpenTTD風に、斜面の切り口へ石造の閉じた
          「箱」を刺す。以前は壁1枚+袖壁の書き割り構成で、低い斜面・対角斜面ではその
          背後の空洞(壁の裏面・開口裏の黒プレート)がカメラに露出してしまっていた。
          ヘッドウォールと同じ外形(アーチの穴あき断面)をPORTAL_BODY_DEPTHぶん奥まで
          一体のExtrudeGeometry(portalGeometryData)として押し出すことで、天井・側面・
          裏面すべてが石材の面だけになり、袖壁を別途足さなくても閉じた箱として成立する。
          ヘッドウォールは境界面よりHEADWALL_EMBED_DEPTHぶん山側へめり込ませて置くことで、
          斜面との間に隙間・浮きが見えないようにする。高さはcomputePortalHeadwallで坑口
          セルの4隅コーナー標高から求め、斜面の切り口を覆うのに十分な高さを確保する。
          構成は手前から「穴あきヘッドウォール(壁厚のみ)→ 黒い終端キャップ(壁背面に
          面一)→ 穴の無い中実ボディ(箱)」のサンドイッチ。ヘッドウォールと箱を1本の
          ExtrudeGeometryとしてアーチ穴ごと押し出すと、箱側にもアーチ型のトンネルが
          貫通してしまい、山側(裏)の面にも穴が開いて奥の黒キャップが裏面の黒いアーチ
          として露出する不具合があったため、穴は壁の中だけで完結させ、箱は穴の無い
          BoxGeometryで裏を完全に塞ぐようにした。黒キャップを壁背面に密着させることで、
          開口を覗くとreveal(壁厚ぶん)のすぐ奥が黒く読め、斜めから見ても石色の内側面が
          支配的にならない。光源が-x側にあるため+x向きの坑口正面が陰りやすく、石壁が
          真っ黒に潰れないよう軽いemissiveを持たせる。トンネル内のレールは地表と同じ
          高さを走るため、開口の基準点は地平(level:0)ならy=0に置く(ヘッドウォールは
          垂直=傾けない)。高架レール(uppers[L])が山岳内部を通る区間の坑口(level>0、
          sim/tunnel.tsのelevatedTunnelPortals)はその高架レベルの高さ(level*OVERPASS_HEIGHT)
          に同じジオメトリを平行移動して置くだけで、地平と同じ見た目の坑口を高架にも
          流用できる。装飾であり選択対象ではないため地面クリックを奪わないよう
          全meshのレイキャストを外す。 */}
      {portalGeometryData.map(({ portal, wallHeight, embedDepth, headwallGeometry }) => {
        // セル境界面(x+dx*0.5, z+dz*0.5)を基準に置く。高架の坑口(level>0)はそのレベルの
        // 高さぶん(level*OVERPASS_HEIGHT)持ち上げる。
        const faceX = portal.x + portal.dx * 0.5;
        const faceZ = portal.z + portal.dz * 0.5;
        // P7c: 地平の坑口(level:0)はcell.tunnel.height(portal.height)ぶん、高架の坑口
        // (level>0)は従来通りlevel*OVERPASS_HEIGHTぶん持ち上げる(elevatedTunnelPortals側で
        // height=levelを詰めているため、この式はどちらにも共通して使える)。
        const faceY = portal.height * OVERPASS_HEIGHT;
        // groupをdx/dz方向(非mountain側)へ向ける。ローカル+Zがこの方向に一致する
        // (=局所+Zが坑口の外向き=手前側、局所-Zが山の内側=奥)。
        const angle = Math.atan2(portal.dx, portal.dz);

        const wallZ = -embedDepth; // 境界面からわずかに山側(-Z)へめり込ませる。
        const wallBackZ = wallZ - wallThickness / 2; // 壁の奥側の面(局所-Z側、山の内部)。
        // 黒キャップは壁背面に面一(フラッシュ)で配置する。
        const mouthCapZ = wallBackZ - tunnelMouthPlateDepth / 2;
        // 中実ボディは黒キャップの背後に密着させ、裏面・側面・天面をすべて石材で塞ぐ。
        const bodyBackFaceZ = wallBackZ - tunnelMouthPlateDepth; // ボディの手前側の面。
        const bodyZ = bodyBackFaceZ - bodyDepth / 2;
        // 笠石(コーピング)。壁天端に幅+奥行きをやや張り出させる。壁よりわずかに濃い
        // トーンにして輪郭が出るようにする。前端(手前側)だけに置く。
        const copingWidth = wallWidth + 0.1;
        const copingThickness = wallThickness + 0.06;
        const copingHeight = 0.08;

        return (
          <group
            key={`portal-${portal.x},${portal.z},${portal.dx},${portal.dz},${portal.level}`}
            position={[faceX, faceY, faceZ]}
            rotation-y={angle}
          >
            {/* ヘッドウォール本体(壁+アーチ開口を一体成形、深さは壁厚のみ)。陰でも
                石壁として読めるよう軽いemissiveを持たせる。ExtrudeGeometryの巻き順に
                依存せず両面から正しく見えるようdoubleSideにする。 */}
            <mesh geometry={headwallGeometry} position={[0, 0, wallZ]} castShadow raycast={() => null}>
              <meshStandardMaterial
                color="#a2a7ae" roughness={1} emissive="#3a3e44" emissiveIntensity={0.35} side={THREE.DoubleSide}
              />
            </mesh>
            {/* 天端の笠石。壁よりひとまわり張り出し、わずかに濃いトーンで輪郭を出す。 */}
            <mesh position={[0, wallHeight + copingHeight / 2, wallZ]} castShadow raycast={() => null}>
              <boxGeometry args={[copingWidth, copingHeight, copingThickness]} />
              <meshStandardMaterial color="#8b9097" roughness={1} emissive="#2c2f33" emissiveIntensity={0.3} />
            </mesh>
            {/* トンネル内部の暗がり。開口と同じ断面形状(アーチ)の薄い平板を壁背面に
                面一で貼り付ける。壁厚(reveal)ぶんの奥にすぐ黒が来るため、どの角度から
                見ても開口内が暗く読める。 */}
            <mesh geometry={tunnelMouthGeometry} position={[0, 0, mouthCapZ]} raycast={() => null}>
              <meshStandardMaterial color="#0b0e12" roughness={1} />
            </mesh>
            {/* 穴の無い中実ボディ。黒キャップの背後に密着させ、天面・側面・裏面すべてを
                石材で閉じる。アーチ穴を持たないBoxGeometryなので、裏から見ても黒い
                アーチが透けて見えることがない。 */}
            <mesh position={[0, wallHeight / 2, bodyZ]} castShadow raycast={() => null}>
              <boxGeometry args={[wallWidth, wallHeight, bodyDepth]} />
              <meshStandardMaterial color="#a2a7ae" roughness={1} emissive="#3a3e44" emissiveIntensity={0.35} />
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
            dimmed={isLevelDimmed(level, undergroundView, buildLevel)}
          />
        );
      })}

      {/* P8b: 地下駅セル(uppers[L].stationIdがあるセル、L<0)。通常表示では隠し、
          地下ビュー中だけ描く(選択レベル以外は暗く)。 */}
      {undergroundView && undergroundCells.map(cell => {
        const level = cell.level ?? -1;
        return (
          <StationBlock
            key={`${cell.key}-underground`}
            position={[cell.x, level * OVERPASS_HEIGHT, cell.z]}
            connections={cell.connections}
            platformDoors={stations.get(cell.stationId)?.platformDoors ?? 'none'}
            isEnd={undergroundEndKeys.has(cell.key)}
            dimmed={isLevelDimmed(level, undergroundView, buildLevel)}
            renderOrder={UNDERGROUND_RENDER_ORDER}
          />
        );
      })}

      {/* R3: 遠景(farViewHidden)ではTownBlocks(1町ごとの詳細な家・道路メッシュ)の代わりに
          TownMarkers(町1つにつきインスタンス1個の安価なドット表現)を出す。R4で町タイルの
          wgpu移管が進むまでの繋ぎ(progress/renderer-integration-plan.md参照)。 */}
      {farViewHidden ? (
        <TownMarkers towns={towns} field={field} />
      ) : (
        <TownBlocks towns={visibleTowns} townSubTiles={visibleTownSubTiles} field={field} dimmed={undergroundView || farViewDimmed} />
      )}

      {/* R3: 遠景(farViewHidden)では駅舎・ラベル(HtmlのDOMオーバーレイ)を出さない。
          全図縮尺では判読できない上、駅数が多いマップではDOM要素の量が無視できなくなる。 */}
      {!farViewHidden && Array.from(stations.values()).map(station => {
        const orderIndices: number[] = [];
        if (selectedTrain) {
          selectedTrain.schedule.forEach((stId, index) => {
            if (stId === station.id) orderIndices.push(index);
          });
        }
        // 駅舎・ラベルは1駅につき1つだけ出す(立体交差の十字駅でも二重にならないように)。
        // 地平セルがあればそちらを優先して駅舎を置き、無ければ最も低い高架レベルの位置に置く。
        const ownGroundCells = station.cells.filter(c => !c.layer);
        // P8b: layerは正(高架)・負(地下)どちらも入り得る(Level型)。ここでの
        // 「一番低いレベル」判定は駅舎を地表に近い側へ置くためのものなので、
        // 高架と地下を区別せず、そのまま数値順(=地表に近い順ではなく生の昇順)で扱う。
        const elevatedLevels = station.cells.map(c => c.layer).filter((l): l is Exclude<typeof l, 0 | undefined> => !!l);
        const hasElevatedCells = elevatedLevels.some(l => l > 0);
        const hasUndergroundCells = elevatedLevels.some(l => l < 0);
        const houseIsElevated = ownGroundCells.length === 0;
        // 駅舎を置くレベル(地平セルが無いときのみ使う)。複数レベルにまたがる駅では、
        // 高架があればその最も低いレベル、無ければ地下の最も浅い(0に近い)レベルに置く
        // (見た目上、地平に近い側のほうが自然なため)。
        const houseLevel = houseIsElevated
          ? (hasElevatedCells
            ? Math.min(...elevatedLevels.filter(l => l > 0))
            : Math.max(...elevatedLevels.filter(l => l < 0)))
          : 1;
        const cellsForHouse = houseIsElevated
          ? station.cells.filter(c => c.layer === houseLevel)
          : ownGroundCells;
        const centreCell = cellsForHouse[Math.floor(cellsForHouse.length / 2)] ?? station.center;
        const centreConnections = houseIsElevated
          ? railMap.get(toKey(centreCell.x, centreCell.z))?.uppers?.[houseLevel as Level]?.connections
          : railMap.get(toKey(centreCell.x, centreCell.z))?.connections;
        const angle = trackAngleFromConnections(centreConnections);
        // 地平の駅舎(P7c)はセルの地形標高ぶん持ち上げる(駅は常にflatセルなので
        // cellHeightAtで単一の標高が求まる)。
        const houseY = houseIsElevated
          ? houseLevel * OVERPASS_HEIGHT
          : field.cellHeightAt(centreCell.x, centreCell.z) * OVERPASS_HEIGHT;
        // 高架ホームを含む駅は、ラベルが高架の上屋にめり込まないよう、最も高いレベルに
        // 合わせてさらに高い位置に出す。
        const labelY = hasElevatedCells
          ? 1.35 + Math.max(...elevatedLevels) * OVERPASS_HEIGHT
          : 1.35 + houseY;
        // P8b: 駅舎が地下(houseIsElevated && houseLevel<0)のときは、地表の駅(地平/高架)を
        // 持たない完全地下駅にかぎり、通常表示では隠す(地下ビュー中だけ出す)。
        const houseIsUnderground = houseIsElevated && houseLevel < 0;
        if (houseIsUnderground && hasUndergroundCells && !ownGroundCells.length && !hasElevatedCells && !undergroundView) {
          return null;
        }
        return (
          <group key={station.id}>
            <StationHouse position={[centreCell.x, houseY, centreCell.z]} angle={angle} />
            <StationLabel station={station} orderIndices={orderIndices} world={world} labelY={labelY} />
          </group>
        );
      })}

      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[groundCentre.x, -0.02, groundCentre.z]}
        receiveShadow
        renderOrder={SURFACE_RENDER_ORDER}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onClick={handleClick}
      >
        <planeGeometry args={[groundSpan, groundSpan]} />
        {/* P8b/P8c: 地下ビュー中はこの地面プレーンを完全不可視にする。
            半透明(opacity 0.3)はもちろん、transparent+opacity 0(アルファ0で
            ブレンドさせて見た目だけ消す案)でも他の減光メッシュ(DIMMED_MATERIALS、
            depthTest:false)が不透明キューの後にこのプレーンより後で重なり書きされる
            際の合成結果として地下線路を覆い隠してしまうことが実機検証で判明した
            (progress/underground-design.md参照。地表・地下ともにdepthTest:falseの
            オブジェクトはZバッファに関係なく描画順だけで重なるため、alpha=0でも
            透過ブレンドの過程で下地を巻き込む)。
            visible=falseにするとポインタピッキング(onPointerMove/onClick等、
            このメッシュがヒットテスト対象を兼ねている)まで無効になるため、
            visibleはtrueのまま維持しつつcolorWrite:falseでフレームバッファへの
            色出力そのものを止める(レイキャストはCPU側のジオメトリ交差判定なので
            colorWrite/depthWriteの影響を受けず、ピッキングは効いたままになる)。
            ここは共有インスタンスではなく地面プレーン専用の1つだけのメッシュなので、
            クローンではなくprops切替で済ませる。 */}
        {/* WebGPUモードでは地表(平地の草地)も下層のwgpuが描くため、このプレーンは
            地下ビューと同じ扱いで色出力だけを止める(ポインタ判定は残る)。 */}
        <meshStandardMaterial
          map={groundTexture} color="#ffffff" roughness={1}
          colorWrite={!undergroundView && !webGpuLayer}
          depthWrite={!undergroundView} depthTest={!undergroundView}
        />
      </mesh>

      {/* 建設モードのときだけグリッドを出す(通常時はジオラマの見た目を邪魔しない) */}
      {buildMode !== 'none' && (
        <gridHelper
          args={[groundSpan, groundSpan, 0x7f9c68, 0x9fbb84]}
          position={[groundCentre.x, 0.004, groundCentre.z]}
        />
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
          key={train.id} data={train} railMap={railMap} terrainField={field} elevatedTunnelIndex={elevatedTunnelIndex}
          runtimes={world.current.runtimes} type="commuter"
          isSelected={train.id === selectedTrainId}
          lineColour={findGroup(groups, train.groupId)?.colour}
          onClick={() => {
            if (buildMode !== 'none') return;
            if (justDraggedRef.current) { justDraggedRef.current = false; return; }
            onSelectTrain(train.id);
          }}
          isDragging={draggingTrainId === train.id}
          dragCell={draggingTrainId === train.id ? cursorPos : null}
          undergroundView={undergroundView}
          selectedLevel={buildLevel}
        />
      ))}
    </>
  );
};
