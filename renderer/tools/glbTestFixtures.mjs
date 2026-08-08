// R4c: テスト専用のglb組み立てヘルパー。validate_train_glb.mjs / trainModelLoader.ts の
// テストが「小さな合成glbフィクスチャ」をメモリ上で作るために使う(実ファイル不要)。

const GLB_MAGIC = 0x46546c67;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

const pad4 = (buf, fill = 0) => {
  const remainder = buf.length % 4;
  if (remainder === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(4 - remainder, fill)]);
};

/**
 * 三角形1つぶんの矩形(2三角形=四角形)を軸並行の箱として作る簡易ボックスメッシュ。
 * 中心(cx,cy,cz)、半サイズ(hx,hy,hz)。y<0を作りたいテストのため中心yを指定できるようにしてある。
 */
export function boxPositionsIndices(cx, cy, cz, hx, hy, hz) {
  const positions = [
    [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
    [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
    [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
  ];
  const indices = [
    0, 1, 2, 0, 2, 3, // -z
    4, 6, 5, 4, 7, 6, // +z
    0, 4, 5, 0, 5, 1, // -y
    3, 2, 6, 3, 6, 7, // +y
    0, 3, 7, 0, 7, 4, // -x
    1, 5, 6, 1, 6, 2, // +x
  ];
  return { positions, indices };
}

/**
 * @param {{ name: string, positions: number[][], indices?: number[] }[]} nodeSpecs
 * @param {object} [extraJson] JSONへマージする追加フィールド(textures/skins/animations付与テスト用)
 * @returns {Buffer}
 */
export function buildGlb(nodeSpecs, extraJson = {}) {
  const binParts = [];
  let binOffset = 0;
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];

  const pushBufferView = (typedArray) => {
    const bytes = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const padded = pad4(bytes);
    binParts.push(padded);
    const view = { buffer: 0, byteOffset: binOffset, byteLength: bytes.length };
    binOffset += padded.length;
    bufferViews.push(view);
    return bufferViews.length - 1;
  };

  for (const spec of nodeSpecs) {
    const posFlat = new Float32Array(spec.positions.flat());
    const posViewIndex = pushBufferView(posFlat);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of spec.positions) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
    }
    accessors.push({
      bufferView: posViewIndex, componentType: 5126, count: spec.positions.length, type: 'VEC3', min, max,
    });
    const posAccessorIndex = accessors.length - 1;

    let indicesAccessorIndex;
    if (spec.indices) {
      const idxArr = new Uint16Array(spec.indices);
      const idxViewIndex = pushBufferView(idxArr);
      accessors.push({ bufferView: idxViewIndex, componentType: 5123, count: spec.indices.length, type: 'SCALAR' });
      indicesAccessorIndex = accessors.length - 1;
    }

    meshes.push({
      primitives: [{
        attributes: { POSITION: posAccessorIndex }, indices: indicesAccessorIndex, mode: 4,
        ...(spec.material !== undefined ? { material: spec.material } : {}),
      }],
    });
    nodes.push({ name: spec.name, mesh: meshes.length - 1 });
  }

  const bin = Buffer.concat(binParts);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
    ...extraJson,
  };

  const jsonBytes = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binBytes = pad4(bin, 0);
  const totalLength = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const out = Buffer.alloc(totalLength);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);
  let offset = 12;
  out.writeUInt32LE(jsonBytes.length, offset); offset += 4;
  out.writeUInt32LE(CHUNK_TYPE_JSON, offset); offset += 4;
  jsonBytes.copy(out, offset); offset += jsonBytes.length;
  out.writeUInt32LE(binBytes.length, offset); offset += 4;
  out.writeUInt32LE(CHUNK_TYPE_BIN, offset); offset += 4;
  binBytes.copy(out, offset); offset += binBytes.length;
  return out;
}

/** 寸法制約を満たす最小限の合格用固定シ(car_head/car_mid とも同一の小さな箱)。 */
export function buildValidTrainGlb() {
  const head = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
  const mid = boxPositionsIndices(0, 0.1, 0, 0.2, 0.1, 0.4);
  return buildGlb([
    { name: 'car_head', ...head },
    { name: 'car_mid', ...mid },
  ]);
}
