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
import * as THREE from './geom';
import { DIR, getOppositeDir, getVectorFromDir } from '../utils';
import { angleFromVector } from './palette';
import { mergeAndDispose } from './mergeGeometry';
import { rampHeightAtPos } from '../sim/trackPath';
import { DEFAULT_GAUGE, type RailGauge } from '../types';

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
// 分岐線を本線へ合流させる位置。本線のセル端まで曲げると不自然な大きなS字になるため、
// セル内でポイントらしく収束させる。
const TURNOUT_JOIN_RATIO = 0.35;

// --- 軌間(PM2)による見た目のスケール ---
// gauge省略(=概念なし/旧セーブ)は必ずスケール1.0=従来どおりの定数そのものになる
// (byte-identicalの無回帰要件)。中心線(sim/trackPath.ts)は軌間を一切見ないので、
// ここで変えるのはレール間隔と枕木幅だけで、列車の走行位置はずれない。
function gaugeScaleFactor(gauge?: RailGauge): number {
  return gauge === undefined ? 1 : gauge / DEFAULT_GAUGE;
}

export interface TrackParts {
  ballast: THREE.BufferGeometry[];
  sleepers: THREE.BufferGeometry[];
  rails: THREE.BufferGeometry[];
}

export type TrackPoint = { x: number; z: number; y?: number };
type Pt = TrackPoint;

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

const curvePoints = (from: Pt, to: Pt): Pt[] => {
  const centre: Pt = { x: 0, z: 0 };
  const points: Pt[] = [];
  for (let i = 0; i <= CURVE_SEGMENTS; i++) {
    points.push(quad(from, centre, to, i / CURVE_SEGMENTS));
  }
  return points;
};

const oppositePair = (arms: Pt[]): [Pt, Pt] | null => {
  let best: [Pt, Pt] | null = null;
  let bestDot = Infinity;
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const a = norm(arms[i].x, arms[i].z);
      const b = norm(arms[j].x, arms[j].z);
      const dot = a.x * b.x + a.z * b.z;
      if (dot < bestDot) {
        bestDot = dot;
        best = [arms[i], arms[j]];
      }
    }
  }
  return best;
};

/**
 * 接続ビットを実際に描く中心線へ変換する。
 *
 * 3方向の接続は、中心から3本を放射状に描くのではなく、最も直線に近い組を本線、
 * 残りを本線の進行元側から分岐するポイントとして描く。単線の交換設備でレールが
 * セル中心に重なって見える問題を避けつつ、隣接セルと共有する境界点は維持する。
 * 高架の桁も同じ中心線を使うため、曲線のレールの下に直線の桁が残らない。
 */
export function buildTrackCentreLines(connections: number): TrackPoint[][] {
  const arms = BOUNDARY_OFFSETS
    .filter(o => connections & o.bit)
    .map(o => ({ x: o.x, z: o.z }));

  if (arms.length === 0) return [];
  if (arms.length === 1) return [[{ x: 0, z: 0 }, arms[0]]];
  if (arms.length === 2) {
    const [a, b] = arms;
    const ua = norm(a.x, a.z);
    const ub = norm(b.x, b.z);
    const isStraight = ua.x * ub.x + ua.z * ub.z < -0.999;
    return [isStraight ? [a, b] : curvePoints(a, b)];
  }

  const main = oppositePair(arms)!;
  const routes: Pt[][] = [[main[0], main[1]]];
  const mainSet = new Set(main);
  const branches = arms.filter(arm => !mainSet.has(arm));

  // 十字交差は2本の直線として描く。残る形(3方向、または斜めを含む複雑な分岐)は
  // 本線の進行元側から曲線で分岐させる。地理的に近い側へ戻すと、交換線の入口で
  // 分岐線が本線の先へ回り込み、ループ状のS字に見えてしまう。
  if (branches.length === 2) {
    const [a, b] = branches;
    const ua = norm(a.x, a.z);
    const ub = norm(b.x, b.z);
    if (ua.x * ub.x + ua.z * ub.z < -0.999) {
      routes.push([a, b]);
      return routes;
    }
  }

  for (const branch of branches) {
    const cn = norm(branch.x, branch.z);
    const source = [...main].sort((a, b) => {
      const an = norm(a.x, a.z);
      const bn = norm(b.x, b.z);
      return (an.x * cn.x + an.z * cn.z) - (bn.x * cn.x + bn.z * cn.z);
    })[0];
    const sn = norm(source.x, source.z);
    if (sn.x * cn.x + sn.z * cn.z > 0) {
      // 本線が曲線で、最も反対向きの端すら分岐と同じ大まかな向き(dot>0)の場合。
      // どちらの端へ寄せても分岐線が本線の中心線をまたぐS字になってしまうため、
      // 行き止まりと同じくセル中心から境界点への直線の腕として描き、
      // 本線を横切らせない。
      routes.push([{ x: 0, z: 0 }, branch]);
      continue;
    }
    const join = { x: source.x * TURNOUT_JOIN_RATIO, z: source.z * TURNOUT_JOIN_RATIO };
    routes.push(curvePoints(branch, join));
  }
  return routes;
}

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
  withBallast = true,
  gauge?: RailGauge
): void => {
  if (points.length < 2) return;
  const scale = gaugeScaleFactor(gauge);
  const railSpacing = RAIL_SPACING * scale;
  const sleeperWidth = SLEEPER_WIDTH * scale;

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
      rail.translate((side * railSpacing) / 2, 0, 0);
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

        const sleeper = new THREE.BoxGeometry(sleeperWidth, SLEEPER_HEIGHT, SLEEPER_THICKNESS);
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
  withBallast = true,
  gauge?: RailGauge
): TrackParts {
  const parts: TrackParts = { ballast: [], sleepers: [], rails: [] };

  const routes = buildTrackCentreLines(connections);
  for (const route of routes) {
    layTrackAlong(parts, route, originX, originZ, originY, withBallast, gauge);
  }
  return parts;
}

/**
 * 地上の傾斜(incline)セルの線路を、低い側の境界(lowY)から高い側の境界(highY)へ
 * 一直線に登る形で生成する(P7c)。地形コーナーが作る面そのものが線形(1段/セル)
 * なので、坂(ramp、rampHeightAtPosのsmoothstep)とは違いここは単純な直線で足りる
 * (地形メッシュの傾斜面とレールがずれないよう、あえて曲げない)。
 * dir は登る方向(高い側)のビット。境界オフセットは正反対どうしで点対称
 * (BOUNDARY_OFFSETS参照)なので、低い側は高い側の符号を反転するだけで求まる。
 * layTrackAlongをそのまま再利用するので、バラスト・枕木・レールの生成方法は
 * buildCellTrackParts/buildRampTrackPartsと共通(見た目の一貫性を保つ)。
 */
export function buildGroundInclineTrackParts(
  dir: number,
  originX = 0,
  originZ = 0,
  lowY = 0,
  highY = 0,
  gauge?: RailGauge
): TrackParts {
  const parts: TrackParts = { ballast: [], sleepers: [], rails: [] };
  const high = BOUNDARY_OFFSETS.find(o => o.bit === dir);
  if (!high) return parts;
  const low = { x: -high.x, z: -high.z };
  const points: Pt[] = [
    { x: low.x, z: low.z, y: lowY },
    { x: high.x, z: high.z, y: highY },
  ];
  layTrackAlong(parts, points, originX, originZ, 0, true, gauge);
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
  segments = RAMP_CURVE_SEGMENTS,
  // 坂の下側レベル(base〜base+1段を登る)。省略時0=地平〜レベル1の従来どおりの坂。
  base = 0,
  gauge?: RailGauge
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
      y: rampHeightAtPos(pos, base),
    });
  }
  // バラスト(砂利)は地平に接する坂(base=0)だけに敷く。base>=1の坂は空中に
  // 架かる桁の上なので、砂利が宙に浮いて見えないよう枕木とレールだけを描く
  // (高架の桁上の線路(buildCellTrackPartsのwithBallast=false)と同じ扱い)。
  layTrackAlong(parts, points, originX, originZ, 0, base === 0, gauge);
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
  // render/geom/ のキットはposition以外を保持しない(bakedMesh.tsが三角形ごとに
  // flat shading用の法線を計算し直すため、normal/uvは最終的な見た目に寄与しない)。
  const pushVertex = (v: number[]) => {
    positions.push(...v);
  };
  const push = (a: number[], b: number[], c: number[]) => {
    pushVertex(a);
    pushVertex(b);
    pushVertex(c);
  };

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

  return new THREE.BufferGeometry(new Float32Array(positions), null);
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

/** レールと同じ中心線に沿って、高架の桁を短い部材として連続配置する。 */
const layDeckAlong = (decks: THREE.BufferGeometry[], points: TrackPoint[], x: number, z: number, originY: number): void => {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const deck = new THREE.BoxGeometry(DECK_WIDTH, DECK_THICKNESS, length + JOIN_OVERLAP * 2);
    deck.rotateY(angleFromVector(dx / length, dz / length));
    deck.translate(x + (a.x + b.x) / 2, originY - DECK_THICKNESS / 2, z + (a.z + b.z) / 2);
    decks.push(deck);
  }
};

/** connections に立っている最初の方向ビットを返す(橋桁は必ず軸1本ぶんの2ビット)。 */
const firstDirBit = (connections: number): number => {
  for (const bit of DIR_BITS) if (connections & bit) return bit;
  return DIR.E;
};

/**
 * 橋脚の間引き(shouldPlacePier)に使う軸を選ぶ。正反対の2ビットが揃った組
 * (=直線の本線)があればその軸を優先する。firstDirBitの固定順(N,NE,E,...)だと、
 * 本線E-Wに分岐NEが付いただけでNE軸の偶奇に切り替わってしまい、本線沿いの
 * 交互配置が崩れて二重橋脚や連続した欠落が出るため。直線の組が無いカーブでは、
 * 従来どおり最初の接続ビット(=いずれかの隣接直線区間の軸と一致する)を使う。
 */
export const pierAxisBit = (connections: number): number => {
  for (const bit of DIR_BITS) {
    if ((connections & bit) && (connections & getOppositeDir(bit))) return bit;
  }
  return firstDirBit(connections);
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
  const decks: THREE.BufferGeometry[] = [];
  for (const route of buildTrackCentreLines(connections)) layDeckAlong(decks, route, x, z, originY);

  const piers: THREE.BufferGeometry[] = [];
  const dir = pierAxisBit(connections);
  if (shouldPlacePier(x, z, dir)) {
    const pierBottom = 0;
    const pierTop = originY - DECK_THICKNESS;
    const pierHeight = Math.max(0.02, pierTop - pierBottom);
    const pier = new THREE.CylinderGeometry(PIER_RADIUS, PIER_RADIUS * 1.3, pierHeight, 8);
    pier.translate(x, pierBottom + pierHeight / 2, z);
    piers.push(pier);
  }

  return { piers, decks };
}

/**
 * 空中に架かる坂(ramp.base >= 1、地平に接しない多レベルの坂)を支える支柱を1本生成する。
 * 坂の下側境界(地面に一番近い側)の高さまで、地面(y=0)から1本の円柱で立てる。
 * buildOverpassSupportParts の橋脚と同じ寸法・shouldPlacePierの間引き判定を流用する。
 */
export function buildRampPierPart(x = 0, z = 0, heightAtLowEnd: number): THREE.BufferGeometry | null {
  if (heightAtLowEnd <= 0.02) return null;
  const pier = new THREE.CylinderGeometry(PIER_RADIUS, PIER_RADIUS * 1.3, heightAtLowEnd, 8);
  pier.translate(x, heightAtLowEnd / 2, z);
  return pier;
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

// --- 掘割ランプの地表開口(P8b) ---
// 通常表示(地下ビューでない)では地下線そのものは隠すが、地表と地下を繋ぐ掘割
// ランプの浅い側(地平に接する側、ramp.base===-1)のセルだけは、地表に「四角い暗い
// 床+短い擁壁」を出す(design memo: カットアウェイは採用せず、ジオラマ的な
// 「開口部の書き割り」で地下への入口を示す)。
//
// R4末: 当初pit(床)をy<0(地表の下)に沈めていたが、地形メッシュはterrainOverlayで
// 実際に掘り下げない限り常にy=0の不透明な連続面のままなので、上から見ると必ず
// 地形に隠れて完全に不可視になる不具合があった(tunnelPortalGeometry.tsの坑口が
// 「地形を一切変形させず、構造物を斜面から張り出させる」方針に倣ったのと同じ理由。
// progress/openttd-tunnel-portals.md Alpha-31a参照)。pit/wallともy>=0の範囲に
// 収め、地形に埋もれず必ず見えるようにした。
const OPENING_PIT_WIDTH = 0.62;
/** 暗い床の厚み。地表からわずかに持ち上げるだけで、実際に掘り下げはしない。 */
const OPENING_PIT_HEIGHT = 0.03;
const OPENING_WALL_THICKNESS = 0.07;
/** 擁壁の高さ。地表からしっかり立ち上げ、掘割の切り通しらしく見せる。 */
const OPENING_WALL_HEIGHT = 0.3;
const OPENING_WALL_OFFSET = 0.34;

export interface UndergroundOpeningParts {
  pit: THREE.BufferGeometry;
  wallA: THREE.BufferGeometry;
  wallB: THREE.BufferGeometry;
}

/**
 * dir(ランプの登り方向=地表側を向くビット)のセル(x,z)に、掘割の開口部を1つ生成する。
 * pitはセルの奥行き方向いっぱいの暗い床(地表すれすれ)、wallA/wallBはその両脇に
 * 地表から立ち上がる擁壁。
 */
export function buildUndergroundOpeningPart(dir: number, x = 0, z = 0): UndergroundOpeningParts | null {
  const high = BOUNDARY_OFFSETS.find(o => o.bit === dir);
  if (!high) return null;
  const len = Math.hypot(high.x, high.z) || 1;
  const ux = high.x / len;
  const uz = high.z / len;
  const rotY = angleFromVector(ux, uz);
  // 進行方向に直交するベクトル(擁壁を左右に振り分けるため)。
  const px = -uz;
  const pz = ux;

  const pit = new THREE.BoxGeometry(OPENING_PIT_WIDTH, OPENING_PIT_HEIGHT, 0.96);
  pit.rotateY(rotY);
  pit.translate(x, OPENING_PIT_HEIGHT / 2, z);

  const makeWall = (side: number): THREE.BufferGeometry => {
    const wall = new THREE.BoxGeometry(OPENING_WALL_THICKNESS, OPENING_WALL_HEIGHT, 0.96);
    wall.rotateY(rotY);
    wall.translate(x + px * side * OPENING_WALL_OFFSET, OPENING_WALL_HEIGHT / 2, z + pz * side * OPENING_WALL_OFFSET);
    return wall;
  };

  return { pit, wallA: makeWall(1), wallB: makeWall(-1) };
}

// --- 架線(catenary、電化区間の見た目)(PM2 follow-up) ---
// ポールを毎セルに立てるとセル数千規模で頂点が破綻するため、間引き判定
// (shouldPlacePierと同じ「軸に沿った整数インデックスの剰余」方式)で数セルおきに
// 1本だけ立てる。電線は間引かず全セルの中心線に沿って敷く(ポールが疎でも
// 線が途切れないように)。地下は呼び出し側(railGeometry.ts)が呼ばないことで
// スコープ外にする(第三軌条の見た目は未実装、progress/play-modes-plan.md参照)。
const CATENARY_POLE_SPACING = 3;
const CATENARY_MAST_WIDTH = 0.05;
const CATENARY_MAST_HEIGHT = 0.55;
const CATENARY_ARM_LENGTH = 0.22;
const CATENARY_ARM_THICKNESS = 0.05;
const CATENARY_WIRE_HEIGHT = 0.5;
const CATENARY_WIRE_THICKNESS = 0.03;
const CATENARY_OFFSET = BALLAST_WIDTH / 2 + 0.12;

export interface CatenaryParts {
  masts: THREE.BufferGeometry[];
  wires: THREE.BufferGeometry[];
}

/** shouldPlacePierと同じ間引き方式。軸方向のセル整数インデックスがCATENARY_POLE_SPACINGの倍数の位置だけポールを立てる。 */
export function shouldPlaceCatenaryMast(x: number, z: number, dir: number): boolean {
  const { x: dx, z: dz } = getVectorFromDir(dir);
  const normSq = dx * dx + dz * dz || 1;
  const idx = Math.round((x * dx + z * dz) / normSq);
  return ((idx % CATENARY_POLE_SPACING) + CATENARY_POLE_SPACING) % CATENARY_POLE_SPACING === 0;
}

/** 中心線に沿って細い電線パーツを敷く(layDeckAlongの架線版)。 */
const layWireAlong = (wires: THREE.BufferGeometry[], points: TrackPoint[], x: number, z: number, originY: number): void => {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const wire = new THREE.BoxGeometry(CATENARY_WIRE_THICKNESS, CATENARY_WIRE_THICKNESS, length + JOIN_OVERLAP * 2);
    wire.rotateY(angleFromVector(dx / length, dz / length));
    wire.translate(x + (a.x + b.x) / 2, originY + CATENARY_WIRE_HEIGHT, z + (a.z + b.z) / 2);
    wires.push(wire);
  }
};

/**
 * 電化セル1つぶんの架線(電線+間引き済みポール)を、セル中心を原点とした
 * ワールド座標(x, z)で生成する。connectionsが0なら何も生成しない。
 * originYを渡すと高架のぶん持ち上げられる(桁の上に立つポールとして扱う)。
 */
export function buildCatenaryParts(connections: number, x = 0, z = 0, originY = 0): CatenaryParts {
  const masts: THREE.BufferGeometry[] = [];
  const wires: THREE.BufferGeometry[] = [];
  if (connections === 0) return { masts, wires };

  for (const route of buildTrackCentreLines(connections)) {
    layWireAlong(wires, route, x, z, originY);
  }

  const dir = pierAxisBit(connections);
  if (shouldPlaceCatenaryMast(x, z, dir)) {
    const { x: dx, z: dz } = getVectorFromDir(dir);
    const len = Math.hypot(dx, dz) || 1;
    // 軸に直交する向きへポールを線路脇へ逃がす。
    const px = -dz / len;
    const pz = dx / len;
    const mx = x + px * CATENARY_OFFSET;
    const mz = z + pz * CATENARY_OFFSET;

    const mast = new THREE.BoxGeometry(CATENARY_MAST_WIDTH, CATENARY_MAST_HEIGHT, CATENARY_MAST_WIDTH);
    mast.translate(mx, originY + CATENARY_MAST_HEIGHT / 2, mz);
    masts.push(mast);

    const rotY = angleFromVector(dx / len, dz / len);
    const arm = new THREE.BoxGeometry(CATENARY_ARM_LENGTH, CATENARY_ARM_THICKNESS, CATENARY_ARM_THICKNESS);
    arm.rotateY(rotY);
    arm.translate(mx - px * (CATENARY_ARM_LENGTH / 2), originY + CATENARY_MAST_HEIGHT - CATENARY_ARM_THICKNESS / 2, mz - pz * (CATENARY_ARM_LENGTH / 2));
    masts.push(arm);
  }

  return { masts, wires };
}

// --- デッドセクション標識(PM3 follow-up) ---
// 実物のデッドセクション標識(架線の死区間を示す白い矩形の標板)を模した、低頂点数の
// 「短い柱+白い標板」の組。findDeadSectionMarkerEdges(deadSectionMarkers.ts)が返す
// 辺(セル+方向)ごとに1組だけ生成する(catenaryのような間引きはしない。境界は元から疎)。
const MARKER_OFFSET = BALLAST_WIDTH / 2 + 0.12;
const MARKER_POLE_WIDTH = 0.04;
const MARKER_POLE_HEIGHT = 0.4;
const MARKER_BOARD_WIDTH = 0.22;
const MARKER_BOARD_HEIGHT = 0.14;
const MARKER_BOARD_THICKNESS = 0.02;

export interface DeadSectionMarkerParts {
  poles: THREE.BufferGeometry[];
  boards: THREE.BufferGeometry[];
}

/**
 * (x, z)セルからdir方向へ進んだ辺の位置に、線路脇へ寄せた標識(柱+標板)を1組生成する。
 * originYを渡すと高架のぶん持ち上げられる(catenaryと同じ扱い)。
 */
export function buildDeadSectionMarkerPart(x: number, z: number, dir: number, originY = 0): DeadSectionMarkerParts {
  const { x: dx, z: dz } = getVectorFromDir(dir);
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  // 辺(2セルの中間点)から、軸に直交する向きへ線路脇まで逃がす。
  const px = -uz;
  const pz = ux;
  const edgeX = x + ux * 0.5;
  const edgeZ = z + uz * 0.5;
  const mx = edgeX + px * MARKER_OFFSET;
  const mz = edgeZ + pz * MARKER_OFFSET;
  const rotY = angleFromVector(ux, uz);

  const pole = new THREE.BoxGeometry(MARKER_POLE_WIDTH, MARKER_POLE_HEIGHT, MARKER_POLE_WIDTH);
  pole.translate(mx, originY + MARKER_POLE_HEIGHT / 2, mz);

  const board = new THREE.BoxGeometry(MARKER_BOARD_WIDTH, MARKER_BOARD_HEIGHT, MARKER_BOARD_THICKNESS);
  board.rotateY(rotY);
  board.translate(mx, originY + MARKER_POLE_HEIGHT - MARKER_BOARD_HEIGHT / 2, mz);

  return { poles: [pole], boards: [board] };
}

/** 部品配列をマージして1つのジオメトリにする(空なら null)。 */
export function mergeParts(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  return mergeAndDispose(geometries);
}
