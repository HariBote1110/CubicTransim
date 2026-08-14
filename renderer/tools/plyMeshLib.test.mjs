import { describe, expect, it } from 'vitest';
import { parsePly, voxelizeFaces, downsampleVoxels, greedyMeshVoxels, transformTriangles, buildTrainGlbBuffer } from './plyMeshLib.mjs';
import { validateTrainGlb } from './validate_train_glb.mjs';

/** 1個の0.25セル(原点を最小角とする立方体)ぶんの6面12三角形PLYテキストを作る。 */
function singleVoxelPly(colour = [200, 100, 50]) {
  const [r, g, b] = colour;
  const s = 0.25;
  // 各面: 4頂点(法線つき) + 2三角形。頂点は面ごとに重複させる(Stormworks出力を模す)。
  const faces = [
    { n: [1, 0, 0], verts: [[s, 0, 0], [s, s, 0], [s, s, s], [s, 0, s]] }, // +x
    { n: [-1, 0, 0], verts: [[0, 0, 0], [0, 0, s], [0, s, s], [0, s, 0]] }, // -x
    { n: [0, 1, 0], verts: [[0, s, 0], [0, s, s], [s, s, s], [s, s, 0]] }, // +y
    { n: [0, -1, 0], verts: [[0, 0, 0], [s, 0, 0], [s, 0, s], [0, 0, s]] }, // -y
    { n: [0, 0, 1], verts: [[0, 0, s], [s, 0, s], [s, s, s], [0, s, s]] }, // +z
    { n: [0, 0, -1], verts: [[0, 0, 0], [0, s, 0], [s, s, 0], [s, 0, 0]] }, // -z
  ];

  const vertexLines = [];
  const faceLines = [];
  let idx = 0;
  for (const f of faces) {
    const base = idx;
    for (const v of f.verts) {
      vertexLines.push(`${v[0]} ${v[1]} ${v[2]} ${f.n[0]} ${f.n[1]} ${f.n[2]} ${r} ${g} ${b}`);
      idx++;
    }
    faceLines.push(`3 ${base} ${base + 1} ${base + 2}`);
    faceLines.push(`3 ${base} ${base + 2} ${base + 3}`);
  }

  return [
    'ply',
    'format ascii 1.0',
    `element vertex ${vertexLines.length}`,
    'property float x', 'property float y', 'property float z',
    'property float nx', 'property float ny', 'property float nz',
    'property uchar red', 'property uchar green', 'property uchar blue',
    `element face ${faceLines.length}`,
    'property list uchar uint vertex_indices',
    'end_header',
    ...vertexLines,
    ...faceLines,
    '',
  ].join('\n');
}

describe('parsePly', () => {
  it('parses vertex and face counts/values', () => {
    const { vertices, faces } = parsePly(singleVoxelPly());
    expect(vertices.length).toBe(24);
    expect(faces.length).toBe(12);
    expect(vertices[0]).toMatchObject({ x: 0.25, y: 0, z: 0, r: 200, g: 100, b: 50 });
    expect(faces[0]).toEqual([0, 1, 2]);
  });
});

describe('voxelizeFaces', () => {
  it('recovers exactly one solid voxel from a single cube', () => {
    const ply = parsePly(singleVoxelPly([10, 20, 30]));
    const voxels = voxelizeFaces(ply, 0.25);
    expect(voxels.size).toBe(1);
    const v = [...voxels.values()][0];
    expect(v.colour).toEqual([10, 20, 30]);
  });

  it('places two adjacent cubes at adjacent voxel indices', () => {
    const s = 0.25;
    const a = parsePly(singleVoxelPly([1, 2, 3]));
    const bText = singleVoxelPly([4, 5, 6]).split('\n').map((line) => {
      const nums = line.trim().split(/\s+/);
      if (nums.length !== 9) return line;
      const x = Number(nums[0]) + s;
      return [x, ...nums.slice(1)].join(' ');
    }).join('\n');
    const b = parsePly(bText);
    const voxelsA = voxelizeFaces(a, s);
    const voxelsB = voxelizeFaces(b, s);
    const va = [...voxelsA.values()][0];
    const vb = [...voxelsB.values()][0];
    expect(vb.x).toBe(va.x + 1);
    expect(vb.y).toBe(va.y);
    expect(vb.z).toBe(va.z);
  });
});

describe('downsampleVoxels', () => {
  it('is identity at factor 1', () => {
    const voxels = new Map([['0,0,0', { x: 0, y: 0, z: 0, colour: [1, 2, 3] }]]);
    const down = downsampleVoxels(voxels, 1);
    expect(down.size).toBe(1);
  });

  it('merges 2x2x2 children into a single coarse voxel with majority colour', () => {
    const voxels = new Map();
    let n = 0;
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
      const colour = n === 0 ? [9, 9, 9] : [1, 1, 1]; // 1つだけ違う色、多数決で[1,1,1]が勝つ
      voxels.set(`${x},${y},${z}`, { x, y, z, colour });
      n++;
    }
    const down = downsampleVoxels(voxels, 2);
    expect(down.size).toBe(1);
    const v = [...down.values()][0];
    expect(v.x).toBe(0); expect(v.y).toBe(0); expect(v.z).toBe(0);
    expect(v.colour).toEqual([1, 1, 1]);
  });

  it('floors negative indices towards negative infinity (no off-by-one at origin)', () => {
    const voxels = new Map([['-1,-1,-1', { x: -1, y: -1, z: -1, colour: [5, 5, 5] }]]);
    const down = downsampleVoxels(voxels, 2);
    const v = [...down.values()][0];
    expect(v.x).toBe(-1); expect(v.y).toBe(-1); expect(v.z).toBe(-1);
  });

  it('ignores fully interior (unexposed) voxels when deciding coarse colour', () => {
    // 4x4x4の中実ブロック。表面(外殻)は銀色、内部(完全に囲まれた2x2x2)は多数を占める別色。
    // 多数決では内部色が勝つはずだが、露出面重み付けなら内部は重み0で表面色が勝つ。
    const voxels = new Map();
    const silver = [194, 195, 199];
    const interiorColour = [1, 1, 1];
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) {
      const isInterior = x >= 1 && x <= 2 && y >= 1 && y <= 2 && z >= 1 && z <= 2;
      const colour = isInterior ? interiorColour : silver;
      voxels.set(`${x},${y},${z}`, { x, y, z, colour });
    }
    const down = downsampleVoxels(voxels, 4);
    expect(down.size).toBe(1);
    const v = [...down.values()][0];
    expect(v.colour).toEqual(silver);
  });

  it('prefers a saturated colour over grey when exposed-face weights are near-tied', () => {
    // グレーは3個並んだ列(端は5面露出、中央は隣接2個で4面露出、合計14)。
    // オレンジは互いに離れた孤立ボクセル2個(各6面露出、合計12)。
    // 単純な露出重みの多数決ならグレー(14)が勝つが、12/14≈0.857で20%以内の僅差のため、
    // 彩度タイブレークにより、より彩度の高いオレンジが勝つ。
    const voxels = new Map();
    const grey = [194, 195, 199];
    const orange = [223, 151, 87];
    const greyPositions = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
    const orangePositions = [[0, 3, 3], [3, 0, 3]];
    for (const [x, y, z] of greyPositions) voxels.set(`${x},${y},${z}`, { x, y, z, colour: grey });
    for (const [x, y, z] of orangePositions) voxels.set(`${x},${y},${z}`, { x, y, z, colour: orange });
    const down = downsampleVoxels(voxels, 4);
    expect(down.size).toBe(1);
    const v = [...down.values()][0];
    expect(v.colour).toEqual(orange);
  });
});

describe('greedyMeshVoxels', () => {
  it('produces exactly 12 triangles (6 faces) for a single voxel', () => {
    const voxels = new Map([['0,0,0', { x: 0, y: 0, z: 0, colour: [7, 7, 7] }]]);
    const tris = greedyMeshVoxels(voxels, 0.25);
    expect(tris.length).toBe(12);
    for (const t of tris) expect(t.colour).toEqual([7, 7, 7]);
  });

  it('removes the shared hidden face between two adjacent same-colour voxels and merges the outer faces', () => {
    const voxels = new Map([
      ['0,0,0', { x: 0, y: 0, z: 0, colour: [7, 7, 7] }],
      ['1,0,0', { x: 1, y: 0, z: 0, colour: [7, 7, 7] }],
    ]);
    const tris = greedyMeshVoxels(voxels, 0.25);
    // 1x1x2直方体: 6面ぶん(±x2枚+±y,±z各1枚統合)=12三角形
    expect(tris.length).toBe(12);
  });

  it('keeps both faces separate when adjacent voxels differ in colour', () => {
    const voxels = new Map([
      ['0,0,0', { x: 0, y: 0, z: 0, colour: [7, 7, 7] }],
      ['1,0,0', { x: 1, y: 0, z: 0, colour: [8, 8, 8] }],
    ]);
    const tris = greedyMeshVoxels(voxels, 0.25);
    // 隠れ面は依然として除去されるが色境界のため統合されない: 2ボクセルぶん(12+12) - 内部2面ぶん(4三角形)
    expect(tris.length).toBe(20);
  });

  it('produces outward-facing winding (cross product of edges points away from centre)', () => {
    const voxels = new Map([['0,0,0', { x: 0, y: 0, z: 0, colour: [7, 7, 7] }]]);
    const tris = greedyMeshVoxels(voxels, 0.25);
    const centre = [0.125, 0.125, 0.125];
    for (const t of tris) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.positions;
      const e1 = [bx - ax, by - ay, bz - az];
      const e2 = [cx - ax, cy - ay, cz - az];
      const normal = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const toFace = [ax - centre[0], ay - centre[1], az - centre[2]];
      const dot = normal[0] * toFace[0] + normal[1] * toFace[1] + normal[2] * toFace[2];
      expect(dot).toBeGreaterThan(0);
    }
  });
});

describe('transformTriangles', () => {
  it('centres X/Z, shifts min Y to 0, and scales Z extent to targetLength', () => {
    const triangles = [
      { positions: [0, 0, 0, 4, 0, 0, 0, 2, 0], colour: [1, 1, 1] },
      { positions: [0, 3, 10, 4, 3, 10, 0, 5, 10], colour: [1, 1, 1] },
    ];
    const { triangles: out, scale, aabb } = transformTriangles(triangles, { targetLength: 0.86 });
    expect(scale).toBeCloseTo(0.86 / 10, 10);
    expect(aabb[1]).toBeCloseTo(0, 10); // minY
    expect((aabb[0] + aabb[3]) / 2).toBeCloseTo(0, 10); // centreX
    expect((aabb[2] + aabb[5]) / 2).toBeCloseTo(0, 10); // centreZ
    expect(aabb[5] - aabb[2]).toBeCloseTo(0.86, 10);
  });

  it('flip rotates 180 degrees about Y (negates X and Z)', () => {
    const triangles = [{ positions: [1, 0, 2, 3, 0, 2, 1, 1, 2], colour: [1, 1, 1] }];
    const plain = transformTriangles(triangles, { targetLength: 1, scale: 1 });
    const flipped = transformTriangles(triangles, { targetLength: 1, scale: 1, flip: true });
    expect(flipped.triangles[0].positions[0]).toBeCloseTo(-plain.triangles[0].positions[0], 10);
    expect(flipped.triangles[0].positions[2]).toBeCloseTo(-plain.triangles[0].positions[2], 10);
  });

  it('non-uniform mode: Z scales to targetLength independently of X/Y, and X/Y share one factor fitting bodyWidth/heightLimit', () => {
    // actual: X extent=8 (width), Y extent=2 (height), Z extent=10 (length)
    const triangles = [
      { positions: [-4, 0, 0, 4, 0, 0, -4, 2, 0], colour: [1, 1, 1] },
      { positions: [-4, 0, 10, 4, 0, 10, -4, 2, 10], colour: [1, 1, 1] },
    ];
    // widthTarget/actualWidth = 0.44/8 = 0.055, heightLimit/actualHeight = 0.60/2 = 0.30
    // -> xyScale should be the smaller, 0.055
    const { triangles: out, aabb } = transformTriangles(triangles, {
      targetLength: 0.86,
      bodyWidth: 0.44,
      heightLimit: 0.6,
    });
    const xyScale = 0.44 / 8;
    const zScale = 0.86 / 10;
    expect(aabb[3] - aabb[0]).toBeCloseTo(8 * xyScale, 10); // X extent uses xyScale, not zScale
    expect(aabb[4] - aabb[1]).toBeCloseTo(2 * xyScale, 10); // Y extent uses xyScale
    expect(aabb[5] - aabb[2]).toBeCloseTo(0.86, 10); // Z extent uses targetLength
    expect(aabb[1]).toBeCloseTo(0, 10); // minY still floored to 0
    expect((aabb[0] + aabb[3]) / 2).toBeCloseTo(0, 10); // still centred on X
    void out;
    void zScale;
  });

  it('non-uniform mode: heightLimit is the binding constraint when the body is tall and narrow', () => {
    // actual: X extent=2 (width), Y extent=6 (height), Z extent=10 (length)
    const triangles = [
      { positions: [-1, 0, 0, 1, 0, 0, -1, 6, 0], colour: [1, 1, 1] },
      { positions: [-1, 0, 10, 1, 0, 10, -1, 6, 10], colour: [1, 1, 1] },
    ];
    // widthTarget/actualWidth = 0.44/2 = 0.22, heightLimit/actualHeight = 0.60/6 = 0.10
    // -> xyScale should be the smaller, 0.10 (height-bound)
    const { aabb } = transformTriangles(triangles, {
      targetLength: 0.86,
      bodyWidth: 0.44,
      heightLimit: 0.6,
    });
    const xyScale = 0.6 / 6;
    expect(aabb[3] - aabb[0]).toBeCloseTo(2 * xyScale, 10);
    expect(aabb[4] - aabb[1]).toBeCloseTo(6 * xyScale, 10);
  });
});

describe('buildTrainGlbBuffer', () => {
  it('produces a glb that passes validateTrainGlb with car_head/car_mid and correct colours', () => {
    const boxTriangles = (colour) => {
      const voxels = new Map([['0,0,0', { x: 0, y: 0, z: 0, colour }]]);
      const raw = greedyMeshVoxels(voxels, 0.25);
      return transformTriangles(raw, { targetLength: 0.5 }).triangles;
    };
    const buffer = buildTrainGlbBuffer([
      { name: 'car_head', triangles: boxTriangles([200, 50, 50]) },
      { name: 'car_mid', triangles: boxTriangles([50, 200, 50]) },
    ]);
    const { ok, checks } = validateTrainGlb(buffer);
    const failed = checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(ok).toBe(true);
  });

  it('groups triangles of the same colour into one material/primitive', () => {
    const voxels = new Map([
      ['0,0,0', { x: 0, y: 0, z: 0, colour: [10, 10, 10] }],
      ['1,0,0', { x: 1, y: 0, z: 0, colour: [10, 10, 10] }],
    ]);
    const triangles = transformTriangles(greedyMeshVoxels(voxels, 0.25), { targetLength: 0.5 }).triangles;
    const buffer = buildTrainGlbBuffer([
      { name: 'car_head', triangles },
      { name: 'car_mid', triangles },
    ]);
    const json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString('utf8'));
    expect(json.materials.length).toBe(1);
    expect(json.meshes[0].primitives.length).toBe(1);
  });
});
