// R4c: 最小限の glTF 2.0 バイナリ(.glb)パーサ。
//
// 依存なし(vendored parser)。列車モデルのバリデータ(validate_train_glb.mjs)専用に
// 必要な部分だけを実装している: JSON/BINチャンクの分離、アクセサの読み出し、
// ノード変換(matrix または TRS)の合成、ノード配下メッシュの三角形数・AABB集計。
//
// 参考: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format

const GLB_MAGIC = 0x46546c67; // 'glTF' (little-endian u32)
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

/**
 * @param {Buffer|Uint8Array} bytes
 * @returns {{ json: any, bin: Uint8Array | null }}
 */
export function parseGlb(bytes) {
  if (bytes.length < 12) throw new Error('ファイルが小さすぎます(glbヘッダ12バイト未満)');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = header.getUint32(0, true);
  if (magic !== GLB_MAGIC) throw new Error('glTFバイナリではありません(マジックナンバー不一致)');
  const version = header.getUint32(4, true);
  if (version !== 2) throw new Error(`未対応のglTFバージョンです(${version}、2のみ対応)`);
  const totalLength = header.getUint32(8, true);

  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < totalLength && offset + 8 <= bytes.length) {
    const chunkLength = header.getUint32(offset, true);
    const chunkType = header.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const chunkData = bytes.subarray(dataStart, dataStart + chunkLength);
    if (chunkType === CHUNK_TYPE_JSON) {
      json = JSON.parse(Buffer.from(chunkData).toString('utf8'));
    } else if (chunkType === CHUNK_TYPE_BIN) {
      bin = chunkData;
    }
    offset = dataStart + chunkLength;
  }
  if (!json) throw new Error('JSONチャンクが見つかりません');
  return { json, bin };
}

const COMPONENT_SIZES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENT_COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

const readComponent = (dv, byteOffset, componentType) => {
  switch (componentType) {
    case 5120: return dv.getInt8(byteOffset);
    case 5121: return dv.getUint8(byteOffset);
    case 5122: return dv.getInt16(byteOffset, true);
    case 5123: return dv.getUint16(byteOffset, true);
    case 5125: return dv.getUint32(byteOffset, true);
    case 5126: return dv.getFloat32(byteOffset, true);
    default: throw new Error(`未対応のcomponentTypeです(${componentType})`);
  }
};

/**
 * アクセサの中身を `number[][]`(要素ごとの成分配列)として読み出す。
 * bufferView.byteStride があればインターリーブされたバッファにも対応する。
 */
export function readAccessor(json, bin, accessorIndex) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`アクセサ ${accessorIndex} が存在しません`);
  if (accessor.bufferView === undefined) return []; // sparse専用など(v1では未対応、空扱い)
  const bufferView = json.bufferViews[accessor.bufferView];
  if (!bin) throw new Error('BINチャンクが無いのにアクセサがバッファを参照しています');
  const componentSize = COMPONENT_SIZES[accessor.componentType];
  const numComponents = TYPE_COMPONENT_COUNTS[accessor.type];
  const elementSize = componentSize * numComponents;
  const stride = bufferView.byteStride ?? elementSize;
  const baseOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);

  const out = new Array(accessor.count);
  for (let i = 0; i < accessor.count; i++) {
    const elementOffset = baseOffset + i * stride;
    const values = new Array(numComponents);
    for (let c = 0; c < numComponents; c++) {
      values[c] = readComponent(dv, elementOffset + c * componentSize, accessor.componentType);
    }
    out[i] = values;
  }
  return out;
}

// --- 4x4行列(列優先、glTF準拠) ---
const mat4Identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const mat4Multiply = (a, b) => {
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

const mat4FromTRS = (t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1]) => {
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

const nodeLocalMatrix = (node) => {
  if (node.matrix) return node.matrix;
  return mat4FromTRS(node.translation, node.rotation, node.scale);
};

const transformPoint = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

/**
 * ノード(とその子孫)配下の全メッシュプリミティブを集計する: 三角形数の合計、
 * ワールド空間AABB([minX,minY,minZ,maxX,maxY,maxZ])、スキン/モーフ使用有無。
 */
export function collectNodeGeometry(json, bin, nodeIndex, parentMatrix = mat4Identity()) {
  const node = json.nodes[nodeIndex];
  const worldMatrix = mat4Multiply(parentMatrix, nodeLocalMatrix(node));

  let triangleCount = 0;
  let hasSkinOrMorph = node.skin !== undefined;
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  const extend = (p) => {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  };

  if (node.mesh !== undefined) {
    const mesh = json.meshes[node.mesh];
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.targets && primitive.targets.length > 0) hasSkinOrMorph = true;
      const positionIndex = primitive.attributes?.POSITION;
      if (positionIndex === undefined) continue;
      const positions = readAccessor(json, bin, positionIndex).map(p => transformPoint(worldMatrix, p));
      for (const p of positions) extend(p);

      const mode = primitive.mode ?? 4; // 4 = TRIANGLES(既定)
      if (mode !== 4) continue; // 三角形以外(LINE/POINT)は三角形数に数えない
      if (primitive.indices !== undefined) {
        const indices = readAccessor(json, bin, primitive.indices);
        triangleCount += Math.floor(indices.length / 3);
      } else {
        triangleCount += Math.floor(positions.length / 3);
      }
    }
  }

  for (const childIndex of node.children ?? []) {
    const child = collectNodeGeometry(json, bin, childIndex, worldMatrix);
    triangleCount += child.triangleCount;
    hasSkinOrMorph = hasSkinOrMorph || child.hasSkinOrMorph;
    if (child.hasGeometry) {
      extend([child.aabb[0], child.aabb[1], child.aabb[2]]);
      extend([child.aabb[3], child.aabb[4], child.aabb[5]]);
    }
  }

  const hasGeometry = Number.isFinite(min[0]);
  return {
    triangleCount,
    hasGeometry,
    aabb: hasGeometry ? [...min, ...max] : [0, 0, 0, 0, 0, 0],
    hasSkinOrMorph,
  };
}

/** シーン直下(ルート)のノードをnameで探す。無ければnull。 */
export function findRootNodeByName(json, name) {
  const sceneIndex = json.scene ?? 0;
  const scene = json.scenes?.[sceneIndex];
  const rootIndices = scene?.nodes ?? [];
  for (const index of rootIndices) {
    if (json.nodes[index]?.name === name) return index;
  }
  return null;
}
