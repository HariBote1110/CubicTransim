import { describe, expect, it } from 'vitest';
import { parsePly, voxelizeFaces, downsampleVoxels, greedyMeshVoxels, transformTriangles } from './plyMeshLib.mjs';

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
});
