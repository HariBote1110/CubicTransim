// R4b: 駅ホーム・駅舎のジオメトリ生成を components/StationBlock.tsx から抽出した純粋関数。
//
// 寸法定数(PLATFORM_HEIGHT等)は components/StationBlock.tsx からexportされたものを
// そのまま使い、配置ロジックの一次情報源を1箇所に保つ(three.js JSX側とwgpu側で
// 同じ数値を二重管理しない)。
import * as THREE from 'three';
import type { PlatformDoorType } from '../types';
import { angleFromVector, PALETTE } from './palette';
import { BOUNDARY_OFFSETS } from './trackGeometry';
import {
  PLATFORM_HEIGHT, PLATFORM_INNER, PLATFORM_OUTER, PLATFORM_WIDTH, PLATFORM_CENTRE,
  TACTILE_WIDTH, CANOPY_HEIGHT, CANOPY_WIDTH, PILLAR_RADIUS,
} from '../components/StationBlock';

/** 線路の接続方向からホームの向き(軌道の軸)を求める(StationBlock.tsxと同じ規約)。 */
export const trackAngleFromConnections = (connections = 0): number => {
  for (const o of BOUNDARY_OFFSETS) {
    if (connections & o.bit) {
      const len = Math.sqrt(o.x * o.x + o.z * o.z) || 1;
      return angleFromVector(o.x / len, o.z / len);
    }
  }
  return angleFromVector(0, 1);
};

export interface ShadedGeometryEntry {
  geometry: THREE.BufferGeometry;
  colour: string;
  /** ホームドアのガラスのみtrue(半透明クラス、頂点色アルファ≈0.55×255)。 */
  translucent?: boolean;
}

const PLATFORM_DOOR_GLASS_ALPHA = Math.round(0.55 * 255);

/**
 * ホーム片側ぶん(床・側面・点字ブロック・上屋・ホームドア)を、セル中心を原点とした
 * ローカル座標(未回転)で生成する。components/StationBlock.tsx の PlatformSide と
 * 同じ寸法・配置。
 */
export function buildPlatformSideGeometries(
  side: 1 | -1,
  doors: PlatformDoorType,
  isEnd: boolean,
): ShadedGeometryEntry[] {
  const entries: ShadedGeometryEntry[] = [];
  const cx = side * PLATFORM_CENTRE;
  const edgeX = side * (PLATFORM_INNER + TACTILE_WIDTH / 2);
  const doorHeight = doors === 'fullscreen' ? CANOPY_HEIGHT - PLATFORM_HEIGHT : 0.17;
  const doorX = side * PLATFORM_INNER;

  const floor = new THREE.BoxGeometry(PLATFORM_WIDTH, PLATFORM_HEIGHT, 1.0);
  floor.translate(cx, PLATFORM_HEIGHT / 2, 0);
  entries.push({ geometry: floor, colour: PALETTE.platform });

  const wall = new THREE.BoxGeometry(0.024, PLATFORM_HEIGHT - 0.02, 1.0);
  wall.translate(side * (PLATFORM_INNER + 0.012), PLATFORM_HEIGHT / 2 - 0.01, 0);
  entries.push({ geometry: wall, colour: PALETTE.platformSide });

  const tactile = new THREE.BoxGeometry(TACTILE_WIDTH, 0.012, 1.0);
  tactile.translate(edgeX, PLATFORM_HEIGHT + 0.005, 0);
  entries.push({ geometry: tactile, colour: PALETTE.tactile });

  const roof = new THREE.BoxGeometry(CANOPY_WIDTH, 0.032, 1.0);
  roof.translate(side * (PLATFORM_OUTER - CANOPY_WIDTH / 2 + 0.02), CANOPY_HEIGHT, 0);
  entries.push({ geometry: roof, colour: PALETTE.canopyRoof });

  for (const z of (isEnd ? [-0.45, 0.45] : [0.45])) {
    const pillar = new THREE.CylinderGeometry(PILLAR_RADIUS, PILLAR_RADIUS, CANOPY_HEIGHT - PLATFORM_HEIGHT, 8);
    pillar.translate(side * (PLATFORM_OUTER - 0.06), (CANOPY_HEIGHT + PLATFORM_HEIGHT) / 2, z);
    entries.push({ geometry: pillar, colour: PALETTE.canopyPillar });
  }

  if (doors !== 'none') {
    for (const z of [-0.32, 0.32]) {
      const door = new THREE.BoxGeometry(0.05, doorHeight, 0.34);
      door.translate(doorX, PLATFORM_HEIGHT + doorHeight / 2, z);
      entries.push({ geometry: door, colour: PALETTE.platformDoor });

      const glass = new THREE.BoxGeometry(0.012, doorHeight * 0.62, 0.28);
      glass.translate(doorX + side * 0.028, PLATFORM_HEIGHT + doorHeight / 2 + 0.01, z);
      entries.push({ geometry: glass, colour: PALETTE.platformDoorGlass, translucent: true });
    }
  }

  return entries;
}

/**
 * 駅セル1つぶん(両側のホーム)を、ワールド座標へ配置して生成する。
 * position は駅セルの中心(y込み)、connections は軌道の向き判定に使う。
 */
export function buildStationCellGeometries(
  position: readonly [number, number, number],
  connections: number | undefined,
  platformDoors: PlatformDoorType,
  isEnd: boolean,
): ShadedGeometryEntry[] {
  const angle = trackAngleFromConnections(connections);
  const [x, y, z] = position;
  const entries: ShadedGeometryEntry[] = [];
  for (const side of [1, -1] as const) {
    for (const entry of buildPlatformSideGeometries(side, platformDoors, isEnd)) {
      entry.geometry.rotateY(angle);
      entry.geometry.translate(x, y, z);
      entries.push(entry);
    }
  }
  return entries;
}

/** ホームドアのガラスに使う頂点色アルファ(半透明クラス用)。 */
export const STATION_GLASS_ALPHA = PLATFORM_DOOR_GLASS_ALPHA;

// --- 駅舎(1駅につき1つ、StationHouseと同じ形状) ---
const HOUSE_BODY_COLOUR = '#efe9df';
const HOUSE_ENTRANCE_COLOUR = '#3a4a55';

/** 駅の中心に置く小さな駅舎を、ワールド座標へ配置して生成する(StationHouseと同じ形)。 */
export function buildStationHouseGeometries(
  position: readonly [number, number, number],
  angle: number,
): ShadedGeometryEntry[] {
  const [x, y, z] = position;
  const entries: ShadedGeometryEntry[] = [];

  const body = new THREE.BoxGeometry(0.7, 0.56, 0.9);
  body.translate(0.95, 0.28, 0);
  entries.push({ geometry: body, colour: HOUSE_BODY_COLOUR });

  const roof = new THREE.ConeGeometry(0.66, 0.24, 4);
  roof.rotateY(Math.PI / 4);
  roof.translate(0.95, 0.66, 0);
  entries.push({ geometry: roof, colour: PALETTE.buildingRoof });

  const entrance = new THREE.BoxGeometry(0.02, 0.3, 0.3);
  entrance.translate(0.95 + 0.355, 0.18, 0);
  entries.push({ geometry: entrance, colour: HOUSE_ENTRANCE_COLOUR });

  for (const entry of entries) {
    entry.geometry.rotateY(angle);
    entry.geometry.translate(x, y, z);
  }
  return entries;
}
