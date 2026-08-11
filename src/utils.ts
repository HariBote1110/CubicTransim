export const DIR = {
  N:  0b10000000,
  NE: 0b01000000,
  E:  0b00100000,
  SE: 0b00010000,
  S:  0b00001000,
  SW: 0b00000100,
  W:  0b00000010,
  NW: 0b00000001,
};

export const toKey = (x: number, z: number) => `${x},${z}`;

export const fromKey = (key: string) => {
  const [x, z] = key.split(',').map(Number);
  return { x, z };
};

export const getDirFromVector = (dx: number, dz: number) => {
  if (dx === 0 && dz === -1) return DIR.N;
  if (dx === 1 && dz === -1) return DIR.NE;
  if (dx === 1 && dz === 0) return DIR.E;
  if (dx === 1 && dz === 1) return DIR.SE;
  if (dx === 0 && dz === 1) return DIR.S;
  if (dx === -1 && dz === 1) return DIR.SW;
  if (dx === -1 && dz === 0) return DIR.W;
  if (dx === -1 && dz === -1) return DIR.NW;
  return 0;
};

export const getVectorFromDir = (dir: number) => {
  if (dir === DIR.N) return { x: 0, z: -1 };
  if (dir === DIR.S) return { x: 0, z: 1 };
  if (dir === DIR.E) return { x: 1, z: 0 };
  if (dir === DIR.W) return { x: -1, z: 0 };
  if (dir === DIR.NE) return { x: 1, z: -1 };
  if (dir === DIR.SE) return { x: 1, z: 1 };
  if (dir === DIR.SW) return { x: -1, z: 1 };
  if (dir === DIR.NW) return { x: -1, z: -1 };
  return { x: 0, z: 0 };
};

export const getOppositeDir = (dir: number) => {
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

// ★修正: 45度刻みで直線を引くロジックに変更
export const getConstrainedPath = (start: {x:number, z:number}, end: {x:number, z:number}) => {
  const path = [];
  const dx = end.x - start.x;
  const dz = end.z - start.z;

  // マウス位置への角度を計算
  const angle = Math.atan2(dz, dx);
  
  // ターゲット座標を決定（縦・横・斜めのいずれかに寄せる）
  let targetX = start.x;
  let targetZ = start.z;

  // 傾きで判定
  // tan(22.5度) ≈ 0.414, tan(67.5度) ≈ 2.414 を閾値にするのが一般的だが
  // 簡易的に 0.5 (約26度) で判定
  const absTan = Math.abs(Math.tan(angle));

  if (absTan < 0.5) {
     // 横 (Horizontal)
     targetX = end.x;
     targetZ = start.z;
  } else if (absTan > 2.0) {
     // 縦 (Vertical)
     targetX = start.x;
     targetZ = end.z;
  } else {
     // 斜め (Diagonal) - 45度にするため dxとdzの絶対値を大きい方に揃える
     const d = Math.max(Math.abs(dx), Math.abs(dz));
     const sigX = Math.sign(dx) || 1;
     const sigZ = Math.sign(dz) || 1;
     targetX = start.x + d * sigX;
     targetZ = start.z + d * sigZ;
  }

  // 直線補間 (ブレゼンハムの簡易版)
  const steps = Math.max(Math.abs(targetX - start.x), Math.abs(targetZ - start.z));
  const stepX = steps === 0 ? 0 : (targetX - start.x) / steps;
  const stepZ = steps === 0 ? 0 : (targetZ - start.z) / steps;

  for(let i=0; i<=steps; i++) {
      path.push({
          x: Math.round(start.x + stepX * i),
          z: Math.round(start.z + stepZ * i)
      });
  }

  return path;
};