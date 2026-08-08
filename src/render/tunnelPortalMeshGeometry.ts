// R4b: トンネル坑口(ヘッドウォール+笠石+暗がり+中実ボディ)のジオメトリ生成を
// GameScene.tsx の坑口JSXから抽出した純粋関数。寸法・断面計算は既存の
// render/tunnelPortalGeometry.ts(純粋な幾何計算)をそのまま使い、ここでは
// THREE.ExtrudeGeometry/BoxGeometry へ実体化してワールド配置するところまでを担う。
import * as THREE from 'three';
import type { TerrainField } from '../sim/terrainField';
import { OVERPASS_HEIGHT } from '../sim/trackPath';
import {
  computePortalHeadwall, buildHeadwallOutline, buildArchOutline, type Point2D,
  PORTAL_WALL_WIDTH, PORTAL_WALL_THICKNESS, PORTAL_BODY_DEPTH, PORTAL_MOUTH_CAP_DEPTH,
} from './tunnelPortalGeometry';
import type { ShadedGeometryEntry } from './stationGeometry';

export interface TunnelPortalLike {
  x: number;
  z: number;
  dx: number;
  dz: number;
  height: number;
}

const HEADWALL_COLOUR = '#a2a7ae';
const COPING_COLOUR = '#8b9097';
const MOUTH_COLOUR = '#0b0e12';
const BODY_COLOUR = '#a2a7ae';

const openingHalfWidth = 0.26;
const openingStraightHeight = 0.26;
const archRadius = openingHalfWidth;

const outlineToShape = (outline: Point2D[]): THREE.Shape => {
  const shape = new THREE.Shape();
  outline.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
  shape.closePath();
  return shape;
};

/** 坑口リスト全体のジオメトリを生成する(GameScene.tsxの portalGeometryData.map と同じ配置計算)。 */
export function buildTunnelPortalGeometries(
  portals: readonly TunnelPortalLike[],
  field: TerrainField,
): ShadedGeometryEntry[] {
  const entries: ShadedGeometryEntry[] = [];
  const wallWidth = PORTAL_WALL_WIDTH;
  const wallThickness = PORTAL_WALL_THICKNESS;
  const tunnelMouthPlateDepth = PORTAL_MOUTH_CAP_DEPTH;
  const bodyDepth = PORTAL_BODY_DEPTH;

  const mouthShape = outlineToShape(buildArchOutline(openingHalfWidth, openingStraightHeight, archRadius));

  for (const portal of portals) {
    const cellCorners = field.cellCornerHeights(portal.x, portal.z);
    const { height: wallHeight, embedDepth } = computePortalHeadwall(
      cellCorners, portal.dx, portal.dz, OVERPASS_HEIGHT,
    );

    const faceX = portal.x + portal.dx * 0.5;
    const faceZ = portal.z + portal.dz * 0.5;
    const faceY = portal.height * OVERPASS_HEIGHT;
    const angle = Math.atan2(portal.dx, portal.dz);

    const wallZ = -embedDepth;
    const wallBackZ = wallZ - wallThickness / 2;
    const mouthCapZ = wallBackZ - tunnelMouthPlateDepth / 2;
    const bodyBackFaceZ = wallBackZ - tunnelMouthPlateDepth;
    const bodyZ = bodyBackFaceZ - bodyDepth / 2;
    const copingWidth = wallWidth + 0.1;
    const copingThickness = wallThickness + 0.06;
    const copingHeight = 0.08;

    const place = (geometry: THREE.BufferGeometry, colour: string) => {
      geometry.rotateY(angle);
      geometry.translate(faceX, faceY, faceZ);
      entries.push({ geometry, colour });
    };

    const headwallShape = outlineToShape(
      buildHeadwallOutline(wallWidth, wallHeight, openingHalfWidth, openingStraightHeight, archRadius),
    );
    const headwall = new THREE.ExtrudeGeometry(headwallShape, { depth: wallThickness, bevelEnabled: false });
    headwall.translate(0, 0, -wallThickness / 2 + wallZ);
    place(headwall, HEADWALL_COLOUR);

    const coping = new THREE.BoxGeometry(copingWidth, copingHeight, copingThickness);
    coping.translate(0, wallHeight + copingHeight / 2, wallZ);
    place(coping, COPING_COLOUR);

    const mouth = new THREE.ExtrudeGeometry(mouthShape, { depth: tunnelMouthPlateDepth, bevelEnabled: false });
    mouth.translate(0, 0, -tunnelMouthPlateDepth + mouthCapZ);
    place(mouth, MOUTH_COLOUR);

    const body = new THREE.BoxGeometry(wallWidth, wallHeight, bodyDepth);
    body.translate(0, wallHeight / 2, bodyZ);
    place(body, BODY_COLOUR);
  }

  return entries;
}
