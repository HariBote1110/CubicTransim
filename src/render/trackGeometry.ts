// 線路(バラスト・枕木・レール)のジオメトリ生成。
//
// セル数が数百規模になるため、セルごとに個別のmeshを作るとドローコールが破綻する。
// ここでは1セルぶんの部品ジオメトリを作り、呼び出し側でネットワーク全体を
// マテリアルごとに1つのBufferGeometryへマージして描画する(=線路全体で3ドローコール)。
//
// 【曲線化について】
// 以前は「セル中心から各境界点へ伸びる直線の腕」を接続方向のぶんだけ並べていた。
// この作り方だと、直線と斜めが切り替わるセル(例: W と NE が接続)で2本の腕が
// セル中心で45°に折れ、内側のレールは重なり外側のレールには切り欠きができて
// つなぎ目が汚くなる。さらに腕の長さが直交0.5・斜め0.707と違うため、
// 枕木の間隔も直線と斜めで揃わなかった。
//
// そこで接続がちょうど2方向のセルでは、境界点Aからセル中心を制御点として
// 境界点Bへ抜ける2次ベジェを中心線とし、その曲線に沿ってバラスト・レール・枕木を
// 敷く。境界点は隣接セルと必ず共有される点(2セルの中心の中点)なので、
// 曲線にしてもセル間で線路が途切れない。分岐(3方向以上)と行き止まり(1方向)は
// 従来どおり中心からの直線の腕で描く。
import * as THREE from 'three';
import { DIR, getVectorFromDir } from '../utils';
import { angleFromVector } from './palette';
import { mergeAndDispose } from './mergeGeometry';
import { rampHeightAtPos } from '../sim/trackPath';

// 各方向ビットに対応する「セル中心→隣接セルとの境界点」までのベクトル。
// 上下左右は辺の中点(距離0.5)、斜めは隣接セルと接する角(距離√2/2)。
// どちらも隣接セル側から見て同じ境界点(= 2セルの中心の中点)を指すため、
// 接続の組み合わせによらずセル間で線路が途切れない。
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
// 枕木の間隔(弧長)。直線でも斜めでも同じ間隔になるよう、腕ごとではなく
// 中心線の弧長を基準に配る。
const SLEEPER_PITCH = 0.24;
// 曲線1本あたりの分割数。増やすほど滑らかになるがジオメトリも増える。
const CURVE_SEGMENTS = 8;
// セグメント同士の継ぎ目を隠すために各セグメントを前後へ伸ばす量。
const JOIN_OVERLAP = 0.02;

export interface TrackParts {
  ballast: THREE.BufferGeometry[];
  sleepers: THREE.BufferGeometry[];
  rails: THREE.BufferGeometry[];
}

type Pt = { x: number; z: number; y?: number };

const norm = (x: number, z: number): Pt => {
  const len = Math.hypot(x, z) || 1;
  return { x: x / len, z: z / len };
};

/** 2次ベジェ B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2 */
const quad = (p0: Pt, p1: Pt, p2: Pt, t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    z: u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z,
  };
};

/**
 * 中心線ポリラインに沿ってバラスト・レール・枕木を敷く。
 * points はセル中心を原点としたローカル座標。origin でワールドへ移す。
 * originY を渡すと立体交差の高架ぶん(OVERPASS_HEIGHT)だけ全体を持ち上げられる。
 *
 * 各点の y(省略時0)が異なる場合、その区間は水平のyawに加えて縦方向のpitchも
 * 掛けて傾ける(坂セルの線路をレール・枕木ごと斜めに登らせるため)。
 * yが全点0のときはpitch=0(no-op)になるので、既存の平坦な呼び出しの結果は変わらない。
 */
const layTrackAlong = (
  parts: TrackParts,
  points: Pt[],
  originX: number,
  originZ: number,
  originY = 0,
  withBallast = true
): void => {
  if (points.length < 2) return;

  // --- セグメントごとにバラストとレールを置く ---
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const ay = a.y ?? 0;
    const by = b.y ?? 0;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const horizLen = Math.hypot(dx, dz);
    const dy = by - ay;
    const segLen3D = Math.hypot(horizLen, dy);
    if (segLen3D < 1e-6) continue;

    const rotY = horizLen > 1e-6 ? angleFromVector(dx / horizLen, dz / horizLen) : 0;
    const pitch = horizLen > 1e-6 ? -Math.atan2(dy, horizLen) : 0;
    const cx = originX + (a.x + b.x) / 2;
    const cz = originZ + (a.z + b.z) / 2;
    const cy = originY + (ay + by) / 2;
    // 継ぎ目を隠すため、両端を少しずつ伸ばす
    const len = segLen3D + JOIN_OVERLAP * 2;

    if (withBallast) {
      const ballast = new THREE.BoxGeometry(BALLAST_WIDTH, BALLAST_HEIGHT, len);
      ballast.rotateX(pitch);
      ballast.rotateY(rotY);
      ballast.translate(cx, cy + BALLAST_HEIGHT / 2, cz);
      parts.ballast.push(ballast);
    }

    for (const side of [-1, 1]) {
      const rail = new THREE.BoxGeometry(RAIL_WIDTH, RAIL_HEIGHT, len);
      rail.translate((side * RAIL_SPACING) / 2, 0, 0);
      rail.rotateX(pitch);
      rail.rotateY(rotY);
      rail.translate(cx, cy + RAIL_TOP - RAIL_HEIGHT / 2, cz);
      parts.rails.push(rail);
    }
  }

  // --- 弧長を等分して枕木を置く(直線でも斜めでも同じ間隔になる) ---
  const segLengths = points.slice(0, -1).map((p, i) => {
    const next = points[i + 1];
    return Math.hypot(next.x - p.x, next.z - p.z, (next.y ?? 0) - (p.y ?? 0));
  });
  const total = segLengths.reduce((s, l) => s + l, 0);
  if (total < 1e-6) return;

  const count = Math.max(1, Math.round(total / SLEEPER_PITCH));
  for (let k = 0; k < count; k++) {
    const target = ((k + 0.5) / count) * total;

    let acc = 0;
    for (let i = 0; i < segLengths.length; i++) {
      if (acc + segLengths[i] >= target || i === segLengths.length - 1) {
        const t = segLengths[i] > 1e-9 ? (target - acc) / segLengths[i] : 0;
        const a = points[i];
        const b = points[i + 1];
        const ay = a.y ?? 0;
        const by = b.y ?? 0;
        const px = a.x + (b.x - a.x) * t;
        const pz = a.z + (b.z - a.z) * t;
        const py = ay + (by - ay) * t;
        const horizLen = Math.hypot(b.x - a.x, b.z - a.z);
        const dir = norm(b.x - a.x, b.z - a.z);
        const pitch = horizLen > 1e-6 ? -Math.atan2(by - ay, horizLen) : 0;

        const sleeper = new THREE.BoxGeometry(SLEEPER_WIDTH, SLEEPER_HEIGHT, SLEEPER_THICKNESS);
        sleeper.rotateX(pitch);
        sleeper.rotateY(angleFromVector(dir.x, dir.z));
        sleeper.translate(originX + px, originY + py + SLEEPER_TOP - SLEEPER_HEIGHT / 2, originZ + pz);
        parts.sleepers.push(sleeper);
        break;
      }
      acc += segLengths[i];
    }
  }
};

/**
 * 1セルぶんの線路部品を、セル中心を原点としたローカル座標で生成する。
 * connections が 0 の場合は何も生成しない(空を返す)。橋桁の下(applyBridgeが
 * 軸ビットを取り除いた地平セル)など、接続が実際に無いセルに幽霊の線路を
 * 描かせないため。建設プレビューで直線プレースホルダーが欲しい場合は、
 * 呼び出し側で明示的に connections(例: DIR.N | DIR.S)を渡すこと。
 * originY を渡すと立体交差の高架側(OVERPASS_HEIGHTぶん上)を描ける。
 */
export function buildCellTrackParts(
  connections: number,
  originX = 0,
  originZ = 0,
  originY = 0,
  withBallast = true
): TrackParts {
  const parts: TrackParts = { ballast: [], sleepers: [], rails: [] };

  const arms: Pt[] = BOUNDARY_OFFSETS.filter(o => connections & o.bit).map(o => ({ x: o.x, z: o.z }));

  if (arms.length === 0) return parts;

  if (arms.length === 2) {
    const [a, b] = arms;
    const ua = norm(a.x, a.z);
    const ub = norm(b.x, b.z);
    // 2方向が正反対なら直線。1セグメントで足りる。
    const isStraight = ua.x * ub.x + ua.z * ub.z < -0.999;

    if (isStraight) {
      layTrackAlong(parts, [a, b], originX, originZ, originY, withBallast);
    } else {
      // 境界点A → セル中心(制御点) → 境界点B の2次ベジェ
      const centre: Pt = { x: 0, z: 0 };
      const points: Pt[] = [];
      for (let i = 0; i <= CURVE_SEGMENTS; i++) {
        points.push(quad(a, centre, b, i / CURVE_SEGMENTS));
      }
      layTrackAlong(parts, points, originX, originZ, originY, withBallast);
    }
    return parts;
  }

  // 分岐(3方向以上)と行き止まり(1方向): 中心から各境界点へ直線の腕を伸ばす。
  // 中心のバラストで腕どうしの継ぎ目を埋める。
  if (withBallast) {
    const pad = new THREE.BoxGeometry(BALLAST_WIDTH, BALLAST_HEIGHT, BALLAST_WIDTH);
    pad.translate(originX, originY + BALLAST_HEIGHT / 2, originZ);
    parts.ballast.push(pad);
  }

  for (const arm of arms) {
    layTrackAlong(parts, [{ x: 0, z: 0 }, arm], originX, originZ, originY, withBallast);
  }
  return parts;
}

// 坂の線路を何本の直線サブセグメントに分けて近似するか。増やすほど滑らかに
// 見えるが、ジオメトリも比例して増える。
const RAMP_CURVE_SEGMENTS = 4;

/**
 * 坂(ramp)セルの線路を、低い側の境界(正規化位置posLow)から高い側の境界
 * (posHigh)へ登る形で生成する。dir は登る方向(高い側=桁のある側)のビット。
 * 境界オフセットは方向ビットの正反対どうしで必ず点対称(BOUNDARY_OFFSETS参照)
 * なので、低い側は高い側の符号を反転するだけで求まる。
 *
 * 1セルをRAMP_CURVE_SEGMENTS本の直線サブセグメントに分割し、各分割点の高さを
 * rampHeightAtPos(sim/trackPath.ts)から求める。posLow/posHighの間をposで
 * 線形補間してからこの1つの曲線関数に通すため、隣接セルとposがつながっている
 * 限り(TrackNetwork.tsx側でRAMP_POS_*を使って揃える)、セルをまたいでも
 * 折れ角の無い縦曲線として繋がる。sim(列車の高さ)と同じ関数を使うので
 * レールと列車の高さがずれない。
 */
export function buildRampTrackParts(
  dir: number,
  originX = 0,
  originZ = 0,
  posLow = 0,
  posHigh = 0,
  segments = RAMP_CURVE_SEGMENTS
): TrackParts {
  const parts: TrackParts = { ballast: [], sleepers: [], rails: [] };
  const high = BOUNDARY_OFFSETS.find(o => o.bit === dir);
  if (!high) return parts;
  const low = { x: -high.x, z: -high.z };

  const n = Math.max(1, segments);
  const points: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const pos = posLow + (posHigh - posLow) * t;
    points.push({
      x: low.x + (high.x - low.x) * t,
      z: low.z + (high.z - low.z) * t,
      y: rampHeightAtPos(pos),
    });
  }
  layTrackAlong(parts, points, originX, originZ, 0, true);
  return parts;
}

/**
 * 縦断プロファイル(heights)に沿ったくさび状ジオメトリを作る。zが「進行方向」の軸で、
 * z=-length/2〜+length/2をheights.length-1個のセグメントに等分し、各分割点の高さを
 * heights[i]とする(heights[0]は低い側、heights[last]は高い側)。底面はy=0固定、
 * 上面はheightsをそのまま結んだ折れ線(セグメントを増やせば曲線に近づく)。
 * 頂点をインデックス無しで積むので、面ごとにフラットシェーディングされる
 * (他のBoxGeometry製パーツと馴染むローポリの見た目)。
 */
function makeCurvedWedgeGeometry(length: number, width: number, heights: number[]): THREE.BufferGeometry {
  const hw = width / 2;
  const hl = length / 2;
  const n = heights.length - 1;

  const positions: number[] = [];
  const push = (a: number[], b: number[], c: number[]) => positions.push(...a, ...b, ...c);

  const zAt = (i: number) => -hl + (length * i) / n;

  for (let i = 0; i < n; i++) {
    const z0 = zAt(i);
    const z1 = zAt(i + 1);
    const h0 = heights[i];
    const h1 = heights[i + 1];
    const lowL = [-hw, 0, z0];
    const lowR = [hw, 0, z0];
    const highBL = [-hw, 0, z1];
    const highBR = [hw, 0, z1];
    const topL0 = [-hw, h0, z0];
    const topR0 = [hw, h0, z0];
    const topL1 = [-hw, h1, z1];
    const topR1 = [hw, h1, z1];

    // 底面(y=0)
    push(lowL, lowR, highBR);
    push(lowL, highBR, highBL);
    // 上面(このセグメントの傾斜面)
    push(topR0, topL0, topL1);
    push(topR0, topL1, topR1);
    // 左右の側面(このセグメント区間の三角)
    push(lowL, topL1, topL0);
    push(lowL, highBL, topL1);
    push(lowR, topR0, topR1);
    push(lowR, topR1, highBR);
  }
  // 高い側の端(z=+length/2)の垂直面(最後のheightぶんを閉じる)
  const lastZ = zAt(n);
  const lastH = heights[n];
  if (lastH > 1e-6) {
    const highBL = [-hw, 0, lastZ];
    const highBR = [hw, 0, lastZ];
    const highTL = [-hw, lastH, lastZ];
    const highTR = [hw, lastH, lastZ];
    push(highBL, highBR, highTR);
    push(highBL, highTR, highTL);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * 坂(ramp)セルを支えるくさび状の橋台ブロックを1つ生成する。
 * 低い側(地面、正規化位置posLow)で高さ0に収束し、高い側(桁寄り、posHigh)へ
 * rampHeightAtPos(sim/trackPath.ts)の曲線に沿って立ち上がる。
 * buildRampTrackParts と同じ高さ関数・分割数を使うので、線路の縦曲線と
 * 橋台の見た目が揃う。
 */
export function buildRampAbutmentPart(
  dir: number,
  x = 0,
  z = 0,
  posHigh = 0,
  posLow = 0,
  segments = RAMP_CURVE_SEGMENTS
): THREE.BufferGeometry | null {
  const high = BOUNDARY_OFFSETS.find(o => o.bit === dir);
  if (!high) return null;
  const low = { x: -high.x, z: -high.z };
  const dx = high.x - low.x;
  const dz = high.z - low.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6 || posHigh <= posLow) return null;

  const n = Math.max(1, segments);
  const heights: number[] = [];
  for (let i = 0; i <= n; i++) {
    const pos = posLow + (posHigh - posLow) * (i / n);
    heights.push(rampHeightAtPos(pos));
  }
  if (heights[n] <= 0) return null;

  const rotY = angleFromVector(dx / len, dz / len);
  const wedge = makeCurvedWedgeGeometry(len, ABUTMENT_WIDTH, heights);
  wedge.rotateY(rotY);
  wedge.translate(x, 0, z);
  return wedge;
}

// --- 橋の桁(ガーダー)・橋脚(ピア)・橋台(アバットメント) ---
// ガーダー橋らしく、桁はレール幅程度の細い板が軸方向に連続して見えるようにし、
// 橋脚は間引いて数セルおきに、両端は橋台の擁壁で地面に取り付ける。
const PIER_RADIUS = 0.045;
const DECK_THICKNESS = 0.08;
// デッキの幅はバラスト幅よりわずかに狭くして、レールの下に収まる細い桁に見せる。
const DECK_WIDTH = BALLAST_WIDTH * 0.82;
const ABUTMENT_LENGTH = 0.34;
const ABUTMENT_WIDTH = BALLAST_WIDTH * 1.3;

export interface SupportParts {
  piers: THREE.BufferGeometry[];
  decks: THREE.BufferGeometry[];
}

const DIR_BITS = [DIR.N, DIR.NE, DIR.E, DIR.SE, DIR.S, DIR.SW, DIR.W, DIR.NW];

/** connections に立っている最初の方向ビットを返す(橋桁は必ず軸1本ぶんの2ビット)。 */
const firstDirBit = (connections: number): number => {
  for (const bit of DIR_BITS) if (connections & bit) return bit;
  return DIR.E;
};

/**
 * 橋脚を間引く判定。橋の軸方向に沿ったセル整数インデックスの偶奇で判定するので、
 * 軸が斜めでも(x, z)いずれかが変化しない方向でも、隣接セル間で必ず交互になる。
 */
export function shouldPlacePier(x: number, z: number, dir: number): boolean {
  const { x: dx, z: dz } = getVectorFromDir(dir);
  const normSq = dx * dx + dz * dz || 1;
  const idx = Math.round((x * dx + z * dz) / normSq);
  return idx % 2 === 0;
}

/**
 * 橋桁セル1つぶんの桁・橋脚を、セル中心を原点としたワールド座標(x, z)で生成する。
 * 桁は境界点A→境界点Bへ真っすぐ渡す細長い板で、trackPath.ts と同じ中心線の
 * 直線区間(橋は必ず直線)に一致させているので、レールの真下に来る。
 * 橋脚はshouldPlacePierがtrueのセルだけに1本、地面から桁下面まで立てる。
 */
export function buildOverpassSupportParts(connections: number, x = 0, z = 0, originY = 0): SupportParts {
  const deckTop = originY; // バラストの底(=originY)にちょうど接するようにする
  const deckCentreY = deckTop - DECK_THICKNESS / 2;
  const decks: THREE.BufferGeometry[] = [];

  const arms = BOUNDARY_OFFSETS.filter(o => connections & o.bit);
  if (arms.length === 2) {
    const [a, b] = arms;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const segLen = Math.hypot(dx, dz);
    if (segLen > 1e-6) {
      const rotY = angleFromVector(dx / segLen, dz / segLen);
      const cx = x + (a.x + b.x) / 2;
      const cz = z + (a.z + b.z) / 2;
      const deck = new THREE.BoxGeometry(DECK_WIDTH, DECK_THICKNESS, segLen + JOIN_OVERLAP * 2);
      deck.rotateY(rotY);
      deck.translate(cx, deckCentreY, cz);
      decks.push(deck);
    }
  }

  const piers: THREE.BufferGeometry[] = [];
  const dir = firstDirBit(connections);
  if (shouldPlacePier(x, z, dir)) {
    const pierBottom = 0;
    const pierTop = deckCentreY - DECK_THICKNESS / 2;
    const pierHeight = Math.max(0.02, pierTop - pierBottom);
    const pier = new THREE.CylinderGeometry(PIER_RADIUS, PIER_RADIUS * 1.3, pierHeight, 8);
    pier.translate(x, pierBottom + pierHeight / 2, z);
    piers.push(pier);
  }

  return { piers, decks };
}

/**
 * 橋台(bridge head)の擁壁を1つ生成する。headX/headZ は橋台側(upperを持たない)
 * セルの座標、dirTowardBridge はそのセルから見て橋桁がある方向のビット。
 * 地平の高さ(y=0)から、隣接する橋桁セルの桁下面(originY - DECK_THICKNESS)までを
 * 埋める箱を、2セルの境界点を中心に置く。
 */
export function buildBridgeAbutmentPart(
  dirTowardBridge: number,
  headX: number,
  headZ: number,
  originY: number
): THREE.BufferGeometry | null {
  const boundary = BOUNDARY_OFFSETS.find(o => o.bit === dirTowardBridge);
  if (!boundary) return null;

  const deckBottom = originY - DECK_THICKNESS;
  if (deckBottom <= 0) return null;

  const u = norm(boundary.x, boundary.z);
  const rotY = angleFromVector(u.x, u.z);

  const abutment = new THREE.BoxGeometry(ABUTMENT_WIDTH, deckBottom, ABUTMENT_LENGTH);
  abutment.rotateY(rotY);
  abutment.translate(headX + boundary.x, deckBottom / 2, headZ + boundary.z);
  return abutment;
}

/** 部品配列をマージして1つのジオメトリにする(空なら null)。 */
export function mergeParts(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  return mergeAndDispose(geometries);
}
