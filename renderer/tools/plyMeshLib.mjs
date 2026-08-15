// R5: Stormworks 製 ASCII PLY(ボクセルモデル)を列車 glb 用の三角形スープへ変換する
// 純粋ロジック(ファイルI/O・CLI引数処理は ply_to_train_glb.mjs 側)。
//
// パイプライン: parsePly → voxelizeFaces(面法線から実グリッド解像度のボクセルを復元)
//   → downsampleVoxels(整数係数で間引き、色は多数決) → greedyMeshVoxels(隠れ面除去+矩形統合)
//   → transformTriangles(センタリング・スケーリング・反転)。
//
// 設計判断は progress/ply-train-import.md を参照。

/**
 * ASCII PLY(vertex: x y z nx ny nz uchar red green blue / face: triangle list)を解析する。
 * @param {string} text
 * @returns {{ vertices: { x:number,y:number,z:number,nx:number,ny:number,nz:number,r:number,g:number,b:number }[], faces: number[][] }}
 */
export function parsePly(text) {
  const lines = text.split('\n');
  let i = 0;
  let vertexCount = 0;
  let faceCount = 0;
  if (lines[i++].trim() !== 'ply') throw new Error('ply: マジック行がありません');
  while (i < lines.length) {
    const line = lines[i++].trim();
    if (line === 'end_header') break;
    const vertexMatch = line.match(/^element vertex (\d+)$/);
    if (vertexMatch) vertexCount = Number(vertexMatch[1]);
    const faceMatch = line.match(/^element face (\d+)$/);
    if (faceMatch) faceCount = Number(faceMatch[1]);
  }

  const vertices = new Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const parts = lines[i++].trim().split(/\s+/).map(Number);
    const [x, y, z, nx, ny, nz, r, g, b] = parts;
    vertices[v] = { x, y, z, nx, ny, nz, r, g, b };
  }

  const faces = new Array(faceCount);
  for (let f = 0; f < faceCount; f++) {
    const parts = lines[i++].trim().split(/\s+/).map(Number);
    const n = parts[0];
    faces[f] = parts.slice(1, 1 + n);
  }

  return { vertices, faces };
}

const round0 = (v) => (Object.is(v, -0) ? 0 : Math.round(v));

/**
 * 面法線から「実グリッド解像度(既定0.25)」のボクセル占有・色を復元する。
 *
 * 各面(三角形)は軸並行の 0.25 セル境界の矩形の半分を成す直角三角形なので、
 * その面のバウンディングボックスは常にセル境界の正方形/矩形と一致する。
 * 法線を最も近い軸(±X/±Y/±Z)へスナップし、法線と逆方向のセルを「実体ボクセル」とみなす。
 * 同一ボクセルに複数の面から色が寄せられた場合は多数決で色を決める。
 *
 * @param {{vertices:object[],faces:number[][]}} ply
 * @param {number} cellSize 実グリッドの1辺(既定0.25、Stormworksのボクセル単位)
 * @returns {Map<string, {x:number,y:number,z:number,colour:[number,number,number]}>}
 */
export function voxelizeFaces(ply, cellSize = 0.25) {
  const { vertices, faces } = ply;
  const half = cellSize / 2;
  /** @type {Map<string, {x:number,y:number,z:number, votes: Map<string,{colour:[number,number,number],count:number}>}>} */
  const voxels = new Map();

  for (const face of faces) {
    if (face.length < 3) continue;
    const a = vertices[face[0]];
    const b = vertices[face[1]];
    const c = vertices[face[2]];

    // 頂点法線の平均を最寄りの軸単位ベクトルへスナップする。
    const nx = round0((a.nx + b.nx + c.nx) / 3);
    const ny = round0((a.ny + b.ny + c.ny) / 3);
    const nz = round0((a.nz + b.nz + c.nz) / 3);
    let axis = -1;
    let sign = 0;
    if (nx !== 0 && ny === 0 && nz === 0) { axis = 0; sign = nx; }
    else if (ny !== 0 && nx === 0 && nz === 0) { axis = 1; sign = ny; }
    else if (nz !== 0 && nx === 0 && ny === 0) { axis = 2; sign = nz; }
    else continue; // 軸並行でない退化面はスキップ

    const p = [a.x, a.y, a.z];
    const bboxMin = [
      Math.min(a.x, b.x, c.x),
      Math.min(a.y, b.y, c.y),
      Math.min(a.z, b.z, c.z),
    ];

    // 法線方向の座標は面(=セル境界)。実体ボクセルは法線と逆方向に厚さcellSize分。
    const planeCoord = p[axis];
    const cellMin = [...bboxMin];
    cellMin[axis] = sign > 0 ? planeCoord - cellSize : planeCoord;

    const idx = cellMin.map((v) => Math.round((v - half) / cellSize));
    const key = idx.join(',');

    const colourKey = `${a.r},${a.g},${a.b}`;
    let entry = voxels.get(key);
    if (!entry) {
      entry = { x: idx[0], y: idx[1], z: idx[2], votes: new Map() };
      voxels.set(key, entry);
    }
    const vote = entry.votes.get(colourKey) ?? { colour: [a.r, a.g, a.b], count: 0 };
    vote.count += 1;
    entry.votes.set(colourKey, vote);
  }

  const out = new Map();
  for (const [key, entry] of voxels) {
    let best = null;
    for (const vote of entry.votes.values()) {
      if (!best || vote.count > best.count) best = vote;
    }
    out.set(key, { x: entry.x, y: entry.y, z: entry.z, colour: best.colour });
  }
  return out;
}

const NEIGHBOUR_OFFSETS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

/** 色の彩度([0,1]、グレーほど0に近い)。RGBの(max-min)/maxで近似する。 */
function saturationOf([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/**
 * ある近接1コーナー粗ボクセル内で最終色を1つ選ぶ。
 * 露出面重みの最大値に対して既定80%(NEAR_TIE_RATIO)以上の候補を「僅差」とみなし、
 * その中で最も彩度が高い色を採用する(彩度は僅差判定を通過した候補間のタイブレークのみに使い、
 * 単独で重みを覆すことはない)。
 * @param {Map<string,{colour:[number,number,number],weight:number}>} weightsByColour
 */
function pickDominantColour(weightsByColour) {
  const candidates = [...weightsByColour.values()];
  candidates.sort((a, b) => b.weight - a.weight);
  const topWeight = candidates[0].weight;
  const nearTieThreshold = topWeight * NEAR_TIE_RATIO;
  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.weight < nearTieThreshold) break;
    if (saturationOf(candidate.colour) > saturationOf(best.colour)) best = candidate;
  }
  return best.colour;
}

const NEAR_TIE_RATIO = 0.5;

/**
 * 整数係数でボクセルを間引く。子ボクセルの色は「露出面(実グリッドで他の実体ボクセルと
 * 接していない面)の数」で重み付けした多数決で決める。完全に囲まれた内部の充填ボクセルは
 * 露出面0となり結果に一切寄与しないため、薄い表面色(帯など)が内部の塗りつぶし色に
 * 埋もれなくなる。重みが僅差(既定80%以内)の場合は、より彩度の高い色を優先する
 * (単独では重みを覆さないタイブレーク専用)。
 * @param {Map<string,{x:number,y:number,z:number,colour:[number,number,number]}>} voxels
 * @param {number} factor 1なら間引きなし
 */
export function downsampleVoxels(voxels, factor) {
  if (factor <= 1) return new Map(voxels);

  const solidAt = (x, y, z) => voxels.has(`${x},${y},${z}`);
  const exposedFaceCount = (v) => {
    let count = 0;
    for (const [dx, dy, dz] of NEIGHBOUR_OFFSETS) {
      if (!solidAt(v.x + dx, v.y + dy, v.z + dz)) count += 1;
    }
    return count;
  };

  const groups = new Map();
  for (const v of voxels.values()) {
    const cx = Math.floor(v.x / factor);
    const cy = Math.floor(v.y / factor);
    const cz = Math.floor(v.z / factor);
    const key = `${cx},${cy},${cz}`;
    let group = groups.get(key);
    if (!group) {
      group = { x: cx, y: cy, z: cz, weights: new Map() };
      groups.set(key, group);
    }
    const weight = exposedFaceCount(v);
    const colourKey = v.colour.join(',');
    const entry = group.weights.get(colourKey) ?? { colour: v.colour, weight: 0 };
    entry.weight += weight;
    group.weights.set(colourKey, entry);
  }
  const out = new Map();
  for (const [key, group] of groups) {
    out.set(key, { x: group.x, y: group.y, z: group.z, colour: pickDominantColour(group.weights) });
  }
  return out;
}

/**
 * ボクセル集合から隠れ面(2つの実体ボクセルに挟まれた面)を除去し、同色の矩形を
 * 貪欲統合(greedy meshing)して三角形スープを作る。
 * @param {Map<string,{x:number,y:number,z:number,colour:[number,number,number]}>} voxels
 * @param {number} cellSize このボクセル集合1マスぶんのワールド単位サイズ
 * @returns {{ positions:[number,number,number,number,number,number,number,number,number], colour:[number,number,number] }[]}
 */
export function greedyMeshVoxels(voxels, cellSize) {
  const colourAt = new Map();
  for (const v of voxels.values()) colourAt.set(`${v.x},${v.y},${v.z}`, v.colour);
  const solidColour = (x, y, z) => colourAt.get(`${x},${y},${z}`) ?? null;

  if (voxels.size === 0) return [];
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const v of voxels.values()) {
    const p = [v.x, v.y, v.z];
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }

  const triangles = [];
  const point = (d, u, v, dVal, uVal, vVal) => {
    const out = [0, 0, 0];
    out[d] = dVal;
    out[u] = uVal;
    out[v] = vVal;
    return out;
  };

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const dMin = min[d];
    const dMax = max[d];
    const uMin = min[u];
    const uMax = max[u];
    const vMin = min[v];
    const vMax = max[v];
    const uSize = uMax - uMin + 1;
    const vSize = vMax - vMin + 1;

    for (let plane = dMin; plane <= dMax + 1; plane++) {
      // マスク: null または {colour, sign}(sign=+1: 法線+d、-1: 法線-d)
      const mask = new Array(uSize * vSize).fill(null);
      const at = (coords) => coords;
      for (let ui = 0; ui < uSize; ui++) {
        for (let vi = 0; vi < vSize; vi++) {
          const uVal = uMin + ui;
          const vVal = vMin + vi;
          const backCoord = point(d, u, v, plane - 1, uVal, vVal);
          const frontCoord = point(d, u, v, plane, uVal, vVal);
          const back = solidColour(...backCoord);
          const front = solidColour(...frontCoord);
          if (back && !front) mask[ui * vSize + vi] = { colour: back, sign: 1 };
          else if (front && !back) mask[ui * vSize + vi] = { colour: front, sign: -1 };
        }
      }

      // 2D 貪欲矩形統合
      const used = new Array(uSize * vSize).fill(false);
      for (let ui = 0; ui < uSize; ui++) {
        for (let vi = 0; vi < vSize; vi++) {
          const cell = mask[ui * vSize + vi];
          if (!cell || used[ui * vSize + vi]) continue;

          // v方向にできるだけ伸ばす
          let vSpan = 1;
          while (vi + vSpan < vSize) {
            const next = mask[ui * vSize + (vi + vSpan)];
            if (!next || used[ui * vSize + (vi + vSpan)] || next.colour.join() !== cell.colour.join() || next.sign !== cell.sign) break;
            vSpan++;
          }
          // u方向にできるだけ伸ばす(v方向のスパン全体が一致する場合のみ)
          let uSpan = 1;
          outer: while (ui + uSpan < uSize) {
            for (let k = 0; k < vSpan; k++) {
              const idx = (ui + uSpan) * vSize + (vi + k);
              const candidate = mask[idx];
              if (!candidate || used[idx] || candidate.colour.join() !== cell.colour.join() || candidate.sign !== cell.sign) break outer;
            }
            uSpan++;
          }

          for (let du = 0; du < uSpan; du++) {
            for (let dv = 0; dv < vSpan; dv++) {
              used[(ui + du) * vSize + (vi + dv)] = true;
            }
          }

          const u0 = (uMin + ui) * cellSize;
          const u1 = (uMin + ui + uSpan) * cellSize;
          const v0 = (vMin + vi) * cellSize;
          const v1 = (vMin + vi + vSpan) * cellSize;
          const dVal = plane * cellSize;

          const p00 = point(d, u, v, dVal, u0, v0);
          const p10 = point(d, u, v, dVal, u1, v0);
          const p11 = point(d, u, v, dVal, u1, v1);
          const p01 = point(d, u, v, dVal, u0, v1);

          if (cell.sign > 0) {
            triangles.push({ positions: [...p00, ...p10, ...p11], colour: cell.colour });
            triangles.push({ positions: [...p00, ...p11, ...p01], colour: cell.colour });
          } else {
            triangles.push({ positions: [...p00, ...p11, ...p10], colour: cell.colour });
            triangles.push({ positions: [...p00, ...p01, ...p11], colour: cell.colour });
          }
        }
      }
    }
  }

  return triangles;
}

/**
 * 三角形スープをゲーム仕様へ変換する: X/Zをセンタリング、最小Y=0へシフト、
 * 全長(Z幅)が targetLength になるようスケール、必要ならY軸180°回転(flip)。
 *
 * bodyWidth/heightLimit を指定すると非一様スケーリング(断面フィット)になる:
 * Z(全長)は targetLength(またはscale)へ従来どおりスケールする一方、X/Yは
 * 実寸の断面アスペクト比を保ったまま min(bodyWidth/実幅, heightLimit/実高さ) の
 * 単一係数を共有してスケールする(ゲームの車両プロポーションに合わせるため、
 * 実寸のリアルな縮尺だと細すぎて見えるデフォルメ対応)。
 * @param {{positions:number[],colour:[number,number,number]}[]} triangles
 * @param {{ targetLength: number, scale?: number, flip?: boolean, bodyWidth?: number, heightLimit?: number }} options
 *   scale を渡すと targetLength を無視してそのZスケールを使う(編成内で全長スケールを揃えるため)。
 *   bodyWidth/heightLimit を渡すと非一様モードになり、X/Yはscale/targetLengthと独立に断面フィットする。
 * @returns {{ triangles: {positions:number[],colour:[number,number,number]}[], scale: number, xyScale: number, aabb: number[] }}
 */
export function transformTriangles(triangles, options) {
  const { targetLength, flip = false, bodyWidth, heightLimit } = options;
  if (triangles.length === 0) return { triangles: [], scale: 1, xyScale: 1, aabb: [0, 0, 0, 0, 0, 0] };

  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const tri of triangles) {
    for (let vi = 0; vi < 3; vi++) {
      for (let k = 0; k < 3; k++) {
        const val = tri.positions[vi * 3 + k];
        if (val < min[k]) min[k] = val;
        if (val > max[k]) max[k] = val;
      }
    }
  }
  const centreX = (min[0] + max[0]) / 2;
  const centreZ = (min[2] + max[2]) / 2;
  const minY = min[1];
  const lengthZ = max[2] - min[2];
  const scale = options.scale ?? (lengthZ > 0 ? targetLength / lengthZ : 1);

  const nonUniform = bodyWidth !== undefined && heightLimit !== undefined;
  let xyScale = scale;
  if (nonUniform) {
    const widthX = max[0] - min[0];
    const heightY = max[1] - min[1];
    const widthFactor = widthX > 0 ? bodyWidth / widthX : Infinity;
    const heightFactor = heightY > 0 ? heightLimit / heightY : Infinity;
    xyScale = Math.min(widthFactor, heightFactor);
  }

  const transformed = triangles.map((tri) => {
    const positions = new Array(9);
    for (let vi = 0; vi < 3; vi++) {
      let x = (tri.positions[vi * 3] - centreX) * xyScale;
      let y = (tri.positions[vi * 3 + 1] - minY) * xyScale;
      let z = (tri.positions[vi * 3 + 2] - centreZ) * scale;
      if (flip) { x = -x; z = -z; }
      positions[vi * 3] = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = z;
    }
    return { positions, colour: tri.colour };
  });

  let outMin = [Infinity, Infinity, Infinity];
  let outMax = [-Infinity, -Infinity, -Infinity];
  for (const tri of transformed) {
    for (let vi = 0; vi < 3; vi++) {
      for (let k = 0; k < 3; k++) {
        const val = tri.positions[vi * 3 + k];
        if (val < outMin[k]) outMin[k] = val;
        if (val > outMax[k]) outMax[k] = val;
      }
    }
  }

  return { triangles: transformed, scale, xyScale, aabb: [...outMin, ...outMax] };
}

/** 色を配列キー(丸め後)にする。同一色は1マテリアルへ束ねるための正規化。 */
const colourKey = (rgb) => rgb.map((c) => Math.round(c)).join(',');

/**
 * 三角形リストを色ごとにグルーピングして glb の「1ノード=1メッシュ、色ごとに1プリミティブ+
 * 専用マテリアル」を組み立てる。既存のテスト用フィクスチャ(glbTestFixtures.mjs)は
 * ノードあたり単一プリミティブ・材質なし前提で本番出力に使えないため、この関数を新設した。
 * 頂点は非インデックス(三角形スープ)のまま出力する(重複コストよりデデュープの複雑さを避けた。
 * 本ツールの出力は数百三角形程度で glb サイズへの影響は軽微)。
 *
 * @param {{ name: string, triangles: {positions:number[],colour:[number,number,number]}[] }[]} carNodes
 * @returns {Buffer}
 */
export function buildTrainGlbBuffer(carNodes) {
  const GLB_MAGIC = 0x46546c67;
  const CHUNK_TYPE_JSON = 0x4e4f534a;
  const CHUNK_TYPE_BIN = 0x004e4942;
  const pad4 = (buf, fill = 0) => {
    const remainder = buf.length % 4;
    if (remainder === 0) return buf;
    return Buffer.concat([buf, Buffer.alloc(4 - remainder, fill)]);
  };

  const binParts = [];
  let binOffset = 0;
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];
  const materials = [];
  const materialIndexByColour = new Map();

  const pushBufferView = (float32Array) => {
    const bytes = Buffer.from(float32Array.buffer, float32Array.byteOffset, float32Array.byteLength);
    const padded = pad4(bytes);
    binParts.push(padded);
    bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: bytes.length });
    binOffset += padded.length;
    return bufferViews.length - 1;
  };

  const materialIndexFor = (colour0to255) => {
    const key = colourKey(colour0to255);
    if (materialIndexByColour.has(key)) return materialIndexByColour.get(key);
    const baseColorFactor = [colour0to255[0] / 255, colour0to255[1] / 255, colour0to255[2] / 255, 1];
    materials.push({ name: `colour_${key.replace(/,/g, '_')}`, pbrMetallicRoughness: { baseColorFactor } });
    const index = materials.length - 1;
    materialIndexByColour.set(key, index);
    return index;
  };

  for (const carNode of carNodes) {
    // 色ごとにグルーピング
    const byColour = new Map();
    for (const tri of carNode.triangles) {
      const key = colourKey(tri.colour);
      let group = byColour.get(key);
      if (!group) { group = { colour: tri.colour, positions: [] }; byColour.set(key, group); }
      group.positions.push(...tri.positions);
    }

    const primitives = [];
    for (const group of byColour.values()) {
      const posFlat = new Float32Array(group.positions);
      const posViewIndex = pushBufferView(posFlat);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < posFlat.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const val = posFlat[i + k];
          if (val < min[k]) min[k] = val;
          if (val > max[k]) max[k] = val;
        }
      }
      accessors.push({ bufferView: posViewIndex, componentType: 5126, count: posFlat.length / 3, type: 'VEC3', min, max });
      primitives.push({
        attributes: { POSITION: accessors.length - 1 },
        material: materialIndexFor(group.colour),
        mode: 4,
      });
    }

    meshes.push({ primitives });
    nodes.push({ name: carNode.name, mesh: meshes.length - 1 });
  }

  const bin = Buffer.concat(binParts);
  const json = {
    asset: { version: '2.0', generator: 'ply_to_train_glb.mjs' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
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
