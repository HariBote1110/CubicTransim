// R4c: 列車モデル(.glb)の実行時ローダ。
//
// progress/train-model-format.md 準拠の .glb を `public/models/trains/<id>.glb` から
// fetch し、ノード変換を平坦化した三角形スープへ焼き込む(car_head/car_mid)。
// マテリアルの baseColorFactor を頂点色に、マテリアル名 `line_colour` を
// tint重み(alpha=255)に変換する。renderer/tools/glbLib.mjs と同種の最小パーサだが、
// こちらはブラウザの ArrayBuffer/DataView で動く必要があるため独立に実装している
// (Node の Buffer に依存する向こうとは実行環境が異なるため共有していない)。
//
// glbが存在しない/取得失敗/必須ノード欠如の場合は null を返す(呼び出し側が
// trainMeshBuilder.ts のプレースホルダへフォールバックする)。

import { bakeFlatShaded, packRgba, type BakedMeshChunk } from './bakedMesh';

const GLB_MAGIC = 0x46546c67;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

interface GlTF {
  asset?: { version?: string };
  scene?: number;
  scenes?: { nodes: number[] }[];
  nodes: GlTFNode[];
  meshes: GlTFMesh[];
  materials?: GlTFMaterial[];
  accessors: GlTFAccessor[];
  bufferViews: GlTFBufferView[];
}
interface GlTFNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}
interface GlTFMesh { primitives: GlTFPrimitive[] }
interface GlTFPrimitive { attributes: { POSITION?: number }; indices?: number; material?: number; mode?: number }
interface GlTFMaterial { name?: string; pbrMetallicRoughness?: { baseColorFactor?: [number, number, number, number] } }
interface GlTFAccessor { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }
interface GlTFBufferView { byteOffset?: number; byteLength: number; byteStride?: number }

const COMPONENT_SIZES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENT_COUNTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function parseGlbBuffer(buffer: ArrayBuffer): { json: GlTF; bin: DataView | null } {
  if (buffer.byteLength < 12) throw new Error('glb: ヘッダが小さすぎます');
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== GLB_MAGIC) throw new Error('glb: マジックナンバー不一致');
  if (header.getUint32(4, true) !== 2) throw new Error('glb: 未対応バージョン');
  const totalLength = header.getUint32(8, true);

  let offset = 12;
  let json: GlTF | null = null;
  let bin: DataView | null = null;
  const decoder = new TextDecoder('utf-8');
  while (offset < totalLength && offset + 8 <= buffer.byteLength) {
    const chunkLength = header.getUint32(offset, true);
    const chunkType = header.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (chunkType === CHUNK_TYPE_JSON) {
      json = JSON.parse(decoder.decode(new Uint8Array(buffer, dataStart, chunkLength))) as GlTF;
    } else if (chunkType === CHUNK_TYPE_BIN) {
      bin = new DataView(buffer, dataStart, chunkLength);
    }
    offset = dataStart + chunkLength;
  }
  if (!json) throw new Error('glb: JSONチャンクがありません');
  return { json, bin };
}

const readComponent = (dv: DataView, byteOffset: number, componentType: number): number => {
  switch (componentType) {
    case 5121: return dv.getUint8(byteOffset);
    case 5123: return dv.getUint16(byteOffset, true);
    case 5125: return dv.getUint32(byteOffset, true);
    case 5126: return dv.getFloat32(byteOffset, true);
    default: throw new Error(`glb: 未対応componentType ${componentType}`);
  }
};

function readAccessor(json: GlTF, bin: DataView, accessorIndex: number): number[][] {
  const accessor = json.accessors[accessorIndex];
  if (accessor.bufferView === undefined) return [];
  const view = json.bufferViews[accessor.bufferView];
  const componentSize = COMPONENT_SIZES[accessor.componentType];
  const numComponents = TYPE_COMPONENT_COUNTS[accessor.type];
  const elementSize = componentSize * numComponents;
  const stride = view.byteStride ?? elementSize;
  const baseOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out: number[][] = new Array(accessor.count);
  for (let i = 0; i < accessor.count; i++) {
    const elementOffset = baseOffset + i * stride;
    const values: number[] = new Array(numComponents);
    for (let c = 0; c < numComponents; c++) values[c] = readComponent(bin, elementOffset + c * componentSize, accessor.componentType);
    out[i] = values;
  }
  return out;
}

type Mat4 = number[];
const mat4Identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mat4Multiply = (a: Mat4, b: Mat4): Mat4 => {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
};
const mat4FromTRS = (t: [number, number, number] = [0, 0, 0], r: [number, number, number, number] = [0, 0, 0, 1], s: [number, number, number] = [1, 1, 1]): Mat4 => {
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
};
const nodeLocalMatrix = (node: GlTFNode): Mat4 => (node.matrix ?? mat4FromTRS(node.translation, node.rotation, node.scale));
const transformPoint = (m: Mat4, p: number[]): [number, number, number] => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

interface TriangleEntry {
  /** 9要素(3頂点×xyz)の三角形スープ。 */
  positions: number[];
  colour: [number, number, number];
  /** trueなら路線色でtintする面(マテリアル名 line_colour)。 */
  tint: boolean;
}

function collectTriangles(json: GlTF, bin: DataView, nodeIndex: number, parentMatrix: Mat4, out: TriangleEntry[]): void {
  const node = json.nodes[nodeIndex];
  const worldMatrix = mat4Multiply(parentMatrix, nodeLocalMatrix(node));

  if (node.mesh !== undefined) {
    const mesh = json.meshes[node.mesh];
    for (const primitive of mesh.primitives) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const positionIndex = primitive.attributes.POSITION;
      if (positionIndex === undefined) continue;
      const positions = readAccessor(json, bin, positionIndex).map(p => transformPoint(worldMatrix, p));
      const material = primitive.material !== undefined ? json.materials?.[primitive.material] : undefined;
      const baseColour = material?.pbrMetallicRoughness?.baseColorFactor;
      const colour: [number, number, number] = baseColour
        ? [baseColour[0], baseColour[1], baseColour[2]]
        : [1, 1, 1];
      const tint = material?.name === 'line_colour';

      const indices = primitive.indices !== undefined
        ? readAccessor(json, bin, primitive.indices).map(v => v[0])
        : positions.map((_, i) => i);

      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = positions[indices[i]];
        const b = positions[indices[i + 1]];
        const c = positions[indices[i + 2]];
        out.push({ positions: [...a, ...b, ...c], colour, tint });
      }
    }
  }

  for (const childIndex of node.children ?? []) {
    collectTriangles(json, bin, childIndex, worldMatrix, out);
  }
}

const findRootNodeByName = (json: GlTF, name: string): number | null => {
  const sceneIndex = json.scene ?? 0;
  const rootIndices = json.scenes?.[sceneIndex]?.nodes ?? [];
  for (const index of rootIndices) if (json.nodes[index]?.name === name) return index;
  return null;
};

/** 1ノード(car_head/car_mid等)ぶんの三角形群を、bakedMesh.tsと同じ規約の頂点色付きメッシュへ焼き込む。 */
function bakeNode(json: GlTF, bin: DataView, nodeIndex: number): BakedMeshChunk | null {
  const triangles: TriangleEntry[] = [];
  collectTriangles(json, bin, nodeIndex, mat4Identity(), triangles);
  if (triangles.length === 0) return null;

  const vertexCount = triangles.length * 3;
  const positions = new Float32Array(vertexCount * 3);
  const colours = new Uint32Array(vertexCount);
  const indices = new Uint32Array(vertexCount);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let cursor = 0;
  for (const tri of triangles) {
    const shaded = bakeFlatShaded(new Float32Array(tri.positions), tri.colour, { alpha: tri.tint ? 255 : 0, unlit: true });
    positions.set(shaded.positions, cursor * 3);
    colours.set(shaded.colours, cursor);
    for (let v = 0; v < 3; v++) {
      const x = shaded.positions[v * 3], y = shaded.positions[v * 3 + 1], z = shaded.positions[v * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      indices[cursor + v] = cursor + v;
    }
    cursor += 3;
  }
  return { positions, colours, indices, aabb: new Float32Array([minX, minY, minZ, maxX, maxY, maxZ]) };
}

export interface LoadedTrainModel {
  head: BakedMeshChunk;
  mid: BakedMeshChunk;
}

/**
 * `public/models/trains/<id>.glb` を fetch して car_head/car_mid を焼き込む。
 * 存在しない/解析失敗/必須ノード欠如の場合は null(呼び出し側でプレースホルダへフォールバック)。
 */
export async function loadTrainModel(id: string): Promise<LoadedTrainModel | null> {
  try {
    const url = new URL(`models/trains/${id}.glb`, document.baseURI).href;
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    return decodeTrainModel(buffer);
  } catch {
    return null;
  }
}

/** fetchを経由しない純粋な解析部分(テスト・トップレベルビルダー双方から呼べる)。 */
export function decodeTrainModel(buffer: ArrayBuffer): LoadedTrainModel | null {
  const { json, bin } = parseGlbBuffer(buffer);
  if (!bin) return null;
  const headIndex = findRootNodeByName(json, 'car_head');
  const midIndex = findRootNodeByName(json, 'car_mid');
  if (headIndex === null || midIndex === null) return null;
  const head = bakeNode(json, bin, headIndex);
  const mid = bakeNode(json, bin, midIndex);
  if (!head || !mid) return null;
  return { head, mid };
}

/**
 * 車種id(TrainType等) → glbモデルid の対応表。R4c時点ではすべてプレースホルダのままで、
 * 実モデル納品後にここへ登録するだけで良い(progress/train-model-format.md参照)。
 */
export const TRAIN_MODEL_REGISTRY: Readonly<Record<string, string>> = {};

/** tint規約の確認用(alpha=255→packRgbaのトップバイトが255になる)にexportしておく。 */
export const TINT_ALPHA_FULL = packRgba(255, 255, 255, 255) >>> 24;
