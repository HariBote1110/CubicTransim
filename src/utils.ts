import type { CellData } from './types';

// --- 座標変換ヘルパー ---
export const toKey = (x: number, z: number) => `${x},${z}`;

export const fromKey = (key: string) => {
  const [x, z] = key.split(',').map(Number);
  return { x, z };
};

interface Pos { x: number; z: number }

/**
 * 2点間を直線(縦横)または斜め(45度)に結ぶグリッド座標の配列を返す
 */
export const getConstrainedPath = (start: Pos, end: Pos): Pos[] => {
  const points: Pos[] = [];
  
  let dx = end.x - start.x;
  let dz = end.z - start.z;
  const absDx = Math.abs(dx);
  const absDz = Math.abs(dz);

  let targetX = start.x;
  let targetZ = start.z;

  if (absDx > absDz * 1.5) {
    targetX = end.x;
    dx = targetX - start.x;
    dz = 0;
  } else if (absDz > absDx * 1.5) {
    targetZ = end.z;
    dx = 0;
    dz = targetZ - start.z;
  } else {
    const dist = Math.max(absDx, absDz);
    targetX = start.x + Math.sign(dx) * dist;
    targetZ = start.z + Math.sign(dz) * dist;
    dx = targetX - start.x;
    dz = targetZ - start.z;
  }

  const steps = Math.max(Math.abs(dx), Math.abs(dz));
  const stepX = Math.sign(dx);
  const stepZ = Math.sign(dz);

  let currX = start.x;
  let currZ = start.z;

  for (let i = 0; i <= steps; i++) {
    points.push({ x: currX, z: currZ });
    currX += stepX;
    currZ += stepZ;
  }

  return points;
};

// --- 方向定義 ---

export const DIR = {
  N:  0b10000000, // (0, -1)
  NE: 0b01000000, // (1, -1)
  E:  0b00100000, // (1, 0)
  SE: 0b00010000, // (1, 1)
  S:  0b00001000, // (0, 1)
  SW: 0b00000100, // (-1, 1)
  W:  0b00000010, // (-1, 0)
  NW: 0b00000001, // (-1, -1)
};

/**
 * ベクトル(dx, dz)を方向ビットに変換する
 */
export const getDirFromVector = (dx: number, dz: number): number => {
  if (dx === 0 && dz === -1) return DIR.N;
  if (dx === 1 && dz === -1) return DIR.NE;
  if (dx === 1 && dz === 0)  return DIR.E;
  if (dx === 1 && dz === 1)  return DIR.SE;
  if (dx === 0 && dz === 1)  return DIR.S;
  if (dx === -1 && dz === 1) return DIR.SW;
  if (dx === -1 && dz === 0) return DIR.W;
  if (dx === -1 && dz === -1) return DIR.NW;
  return 0;
};

/**
 * 逆方向のビットを取得する (例: 北 -> 南)
 */
export const getOppositeDir = (dir: number): number => {
  if (dir === DIR.N) return DIR.S;
  if (dir === DIR.NE) return DIR.SW;
  if (dir === DIR.E) return DIR.W;
  if (dir === DIR.SE) return DIR.NW;
  if (dir === DIR.S) return DIR.N;
  if (dir === DIR.SW) return DIR.NE;
  if (dir === DIR.W) return DIR.E;
  if (dir === DIR.NW) return DIR.SE;
  return 0;
};