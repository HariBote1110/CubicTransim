// D1: 透視投影(乗客視点スパイク)用の地形メッシュ生成。
//
// クォータービューの地形は wasm 側の iso indirect-draw タイル機構(terrain_draw.wgsl)で
// 描くが、透視パスはそれを一切使わない(progress/play-modes-plan.md の「遠い将来の夢」
// メモどおり、乗客視点は既存の透視カメラ機構が無かったので新設した)。代わりに
// `field.cellCornerHeights` から素朴なグリッドメッシュを作り、既存の
// `uploadMeshChunk`(R4a のジオラマ物と同じ経路、Surfaceクラス)へ載せる。
//
// 視点周辺の半径 `radiusCells` 分だけをオンデマンドに作る(16Kマップ全体を実体化しない)。
// 呼び出し側(WebGpuTerrainLayer 等)が視点移動のたびに作り直して同じ id で
// upload_mesh_chunk へ渡す想定。

import { bakeFlatShaded, type BakedMeshChunk } from './bakedMesh';
import type { TerrainField } from '../sim/terrainField';
import { OVERPASS_HEIGHT } from '../sim/trackPath';

/** 地表の基本色(wgpu 側クォータービューのクリア色相当の草地グリーン)。 */
const TERRAIN_COLOUR: readonly [number, number, number] = [0.55, 0.63, 0.38];

/**
 * 視点(centreX, centreZ)を中心に半径 radiusCells のセル範囲を、コーナー高さから
 * 三角形スープへ焼く。1セル=2三角形、法線は cellCornerHeights の並び(nw/ne/sw/se)から
 * 実測するので、隣接セルの段差(1-Lipschitz構成)にかかわらずどんな高さでも正しい面法線になる。
 */
export function buildPerspectiveTerrainMesh(
  field: TerrainField,
  centreX: number,
  centreZ: number,
  radiusCells: number,
): BakedMeshChunk | null {
  const x0 = Math.floor(centreX - radiusCells);
  const z0 = Math.floor(centreZ - radiusCells);
  const x1 = Math.ceil(centreX + radiusCells);
  const z1 = Math.ceil(centreZ + radiusCells);
  const cellCount = Math.max(0, x1 - x0) * Math.max(0, z1 - z0);
  if (cellCount === 0) return null;

  const positions = new Float32Array(cellCount * 18); // 2 triangles * 3 verts * 3 floats
  let o = 0;
  for (let x = x0; x < x1; x++) {
    for (let z = z0; z < z1; z++) {
      const [nw, ne, sw, se] = field.cellCornerHeights(x, z);
      const nwY = nw * OVERPASS_HEIGHT;
      const neY = ne * OVERPASS_HEIGHT;
      const swY = sw * OVERPASS_HEIGHT;
      const seY = se * OVERPASS_HEIGHT;
      // 三角形1: nw, sw, ne (上向き法線になる巻き順)
      positions[o++] = x; positions[o++] = nwY; positions[o++] = z;
      positions[o++] = x; positions[o++] = swY; positions[o++] = z + 1;
      positions[o++] = x + 1; positions[o++] = neY; positions[o++] = z;
      // 三角形2: ne, sw, se
      positions[o++] = x + 1; positions[o++] = neY; positions[o++] = z;
      positions[o++] = x; positions[o++] = swY; positions[o++] = z + 1;
      positions[o++] = x + 1; positions[o++] = seY; positions[o++] = z + 1;
    }
  }

  const shaded = bakeFlatShaded(positions, TERRAIN_COLOUR);
  const vertexCount = shaded.colours.length;
  const indices = new Uint32Array(vertexCount);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    indices[i] = i;
    const px = shaded.positions[i * 3];
    const py = shaded.positions[i * 3 + 1];
    const pz = shaded.positions[i * 3 + 2];
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (pz < minZ) minZ = pz;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
    if (pz > maxZ) maxZ = pz;
  }
  return {
    positions: shaded.positions,
    colours: shaded.colours,
    indices,
    aabb: new Float32Array([minX, minY, minZ, maxX, maxY, maxZ]),
  };
}

/** 透視パスの地形メッシュチャンクに使う固定 id(通常のジオラマ物とは別の名前空間)。 */
export const PERSPECTIVE_TERRAIN_CHUNK_ID = 0xa000_0001;
