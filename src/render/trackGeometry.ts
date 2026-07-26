// 線路(バラスト・枕木・レール)のジオメトリ生成。
//
// セル数が数百規模になるため、セルごとに10個以上のmeshを作るとドローコールが破綻する。
// ここでは1セルぶんの部品ジオメトリを作り、呼び出し側でネットワーク全体を
// マテリアルごとに1つのBufferGeometryへマージして描画する(=線路全体で3ドローコール)。
import * as THREE from 'three';
import { DIR } from '../utils';
import { angleFromVector } from './palette';
import { mergeAndDispose } from './mergeGeometry';

// 各方向ビットに対応する「セル中心→隣接セルとの境界点」までのベクトル。
// 上下左右は辺の中点(距離0.5)、斜めは隣接セルと接する角(距離√2/2)。
// どちらも隣接セル側から見て同じ境界点を指すため、接続の組み合わせによらず
// セル間で線路が途切れない。
export const BOUNDARY_OFFSETS: { bit: number; x: number; z: number }[] = [
  { bit: DIR.N, x: 0, z: -0.5 },
  { bit: DIR.NE, x: 0.5, z: -0.5 },
  { bit: DIR.E, x: 0.5, z: 0 },
  { bit: DIR.SE, x: 0.5, z: 0.5 },
  { bit: DIR.S, x: 0, z: 0.5 },
  { bit: DIR.SW, x: -0.5, z: 0.5 },
  { bit: DIR.W, x: -0.5, z: 0 },
  { bit: DIR.NW, x: -0.5, z: -0.5 },
];

// --- 寸法(1セル=1.0) ---
export const BALLAST_WIDTH = 0.5;
export const BALLAST_HEIGHT = 0.06;
export const SLEEPER_TOP = 0.095;
export const RAIL_TOP = 0.13;
const SLEEPER_WIDTH = 0.4;
const SLEEPER_THICKNESS = 0.07;
const SLEEPER_HEIGHT = 0.035;
const RAIL_SPACING = 0.25;
const RAIL_WIDTH = 0.045;
const RAIL_HEIGHT = 0.05;
// 1方向あたりの枕木本数。多いほど密に見えるがジオメトリも増える。
const SLEEPERS_PER_ARM = 3;

export interface TrackParts {
  ballast: THREE.BufferGeometry[];
  sleepers: THREE.BufferGeometry[];
  rails: THREE.BufferGeometry[];
}

const boxAt = (
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  rotY: number
): THREE.BufferGeometry => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY !== 0) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
};

/**
 * 1セルぶんの線路部品を、セル中心を原点としたローカル座標で生成する。
 * connections が 0(建設プレビューなど)の場合は南北方向の直線1本ぶんを返す。
 */
export function buildCellTrackParts(connections: number, originX = 0, originZ = 0): TrackParts {
  const parts: TrackParts = { ballast: [], sleepers: [], rails: [] };

  const arms = connections === 0
    ? [{ x: 0, z: -0.5 }, { x: 0, z: 0.5 }]
    : BOUNDARY_OFFSETS.filter(o => connections & o.bit).map(o => ({ x: o.x, z: o.z }));

  // 中心の継ぎ目を埋めるバラスト(どの接続の組み合わせでも中央は必ず敷く)
  parts.ballast.push(
    boxAt(BALLAST_WIDTH, BALLAST_HEIGHT, BALLAST_WIDTH, originX, BALLAST_HEIGHT / 2, originZ, 0)
  );

  for (const arm of arms) {
    const length = Math.sqrt(arm.x * arm.x + arm.z * arm.z);
    const rotY = angleFromVector(arm.x / length, arm.z / length);
    const cx = originX + arm.x / 2;
    const cz = originZ + arm.z / 2;

    // バラスト(中心→境界点)
    parts.ballast.push(boxAt(BALLAST_WIDTH, BALLAST_HEIGHT, length, cx, BALLAST_HEIGHT / 2, cz, rotY));

    // レール2本
    for (const side of [-1, 1]) {
      const ox = (side * RAIL_SPACING) / 2;
      const g = new THREE.BoxGeometry(RAIL_WIDTH, RAIL_HEIGHT, length);
      g.translate(ox, 0, 0);
      g.rotateY(rotY);
      g.translate(cx, RAIL_TOP - RAIL_HEIGHT / 2, cz);
      parts.rails.push(g);
    }

    // 枕木(中心寄りは他の腕と重なるので、外側寄りに配置する)
    for (let i = 0; i < SLEEPERS_PER_ARM; i++) {
      const t = (i + 0.8) / (SLEEPERS_PER_ARM + 0.6); // 0.3〜0.9 あたり
      const g = new THREE.BoxGeometry(SLEEPER_WIDTH, SLEEPER_HEIGHT, SLEEPER_THICKNESS);
      g.translate(0, 0, (t - 0.5) * length);
      g.rotateY(rotY);
      g.translate(cx, SLEEPER_TOP - SLEEPER_HEIGHT / 2, cz);
      parts.sleepers.push(g);
    }
  }

  return parts;
}

/** 部品配列をマージして1つのジオメトリにする(空なら null)。 */
export function mergeParts(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  return mergeAndDispose(geometries);
}
