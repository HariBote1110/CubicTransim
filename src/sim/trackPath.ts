// 線路の中心線(セルを通る実際の走行線)の定義。
//
// セル列は中心座標の並びだが、線路は「セル中心をそのまま折れ線で結んだ形」では敷かれない。
// 隣接する2セルの境界点(= 2つのセル中心の中点)を通り、セル中心を制御点とする
// 2次ベジェが実際の線路形状になる(描画側 render/trackGeometry.ts も同じ定義で
// レールを敷いている)。列車の描画位置もこの中心線に載せないと、カーブで
// 車両がレールから外れて見える。
//
// 重要な性質: prev/curr/next が同一直線上に等間隔で並ぶ(=直線区間)場合、
// この曲線は「セル中心間の線形補間」と完全に一致する。したがって直線区間の
// 挙動は従来と1ビットも変わらない。

export type Pt = { x: number; z: number };

// 立体交差の高架セルを走行中の列車の描画高さ(地平からの上乗せ分、renderPos.y相当の単位)。
// simulation.tsのrenderPos.yは 0.5 + (layer===1 ? OVERPASS_HEIGHT : 0) を基準に、
// 地平/高架の境界セルではセル内の進捗で線形補間する。
export const OVERPASS_HEIGHT = 1.2;

const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 2次ベジェ B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2 */
const quad = (p0: Pt, p1: Pt, p2: Pt, t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    z: u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z,
  };
};

/**
 * セル curr を通る中心線上の点。t=0 が prev 側の境界点、t=0.5 がカーブの頂点、
 * t=1 が next 側の境界点。prev/next が無い端では curr のセル中心で止める。
 */
export function cellCurvePoint(prev: Pt | null, curr: Pt, next: Pt | null, t: number): Pt {
  const entry = prev ? midpoint(prev, curr) : curr;
  const exit = next ? midpoint(curr, next) : curr;
  return quad(entry, curr, exit, clamp01(t));
}

/** prev/curr/next がほぼ同一直線上か(直線区間なら曲線サンプルを省ける)。 */
export function isCollinear(prev: Pt | null, curr: Pt, next: Pt | null): boolean {
  if (!prev || !next) return true;
  const ax = curr.x - prev.x;
  const az = curr.z - prev.z;
  const bx = next.x - curr.x;
  const bz = next.z - curr.z;
  const la = Math.hypot(ax, az);
  const lb = Math.hypot(bx, bz);
  if (la < 1e-9 || lb < 1e-9) return true;
  return (ax * bx + az * bz) / (la * lb) > 0.999;
}

/**
 * 「セル curr から next へ progress だけ進んだ位置」を中心線上で求める。
 *
 * progress は従来どおり curr→next の直線区間を 0→1 で刻む値。
 *  - progress <= 0.5 : curr のセル曲線の後半(t = 0.5 + progress)
 *  - progress >  0.5 : next のセル曲線の前半(t = progress - 0.5)
 * 境目(progress = 0.5)はどちらも curr と next の境界点になるので連続。
 * 端数停車で progress が負値になる場合も、curr のセル曲線の前半に収まる。
 */
export function pathPointAt(
  prev: Pt | null,
  curr: Pt,
  next: Pt | null,
  nextNext: Pt | null,
  progress: number
): Pt {
  if (!next) return cellCurvePoint(prev, curr, null, 0.5 + progress);
  if (progress <= 0.5) return cellCurvePoint(prev, curr, next, 0.5 + progress);
  return cellCurvePoint(curr, next, nextNext, progress - 0.5);
}

/**
 * セル curr の中心線を、パラメータ from から to へ辿る点列を points へ追加する。
 * from の点は「直前に追加済み」とみなして含めない(重複を避けるため)。
 */
const emitCurve = (
  points: Pt[],
  prev: Pt | null,
  curr: Pt,
  next: Pt | null,
  from: number,
  to: number,
  samples: number
): void => {
  if (isCollinear(prev, curr, next)) {
    // 直線区間は端点だけで十分(中間点は同一直線上に並ぶだけ)
    points.push(cellCurvePoint(prev, curr, next, to));
    return;
  }
  for (let s = 1; s <= samples; s++) {
    points.push(cellCurvePoint(prev, curr, next, from + (to - from) * (s / samples)));
  }
};

export interface TrainPolylineInput {
  /** 先頭車の描画位置(中心線上にある想定) */
  head: Pt;
  /** 現在のセル(= runtime.grid)。history[0] と一致する */
  grid: Pt;
  /** 1つ前のセル(= runtime.prevGrid) */
  prevGrid: Pt | null;
  /** grid→route[0] の進捗。端数停車では負値になり得る */
  progress: number;
  /** 残りの経路(route[0] が次のセル) */
  route: Pt[];
  /** 通過済みセル中心の列。history[0] が最新(= grid) */
  history: Pt[];
  samples?: number;
}

/**
 * 先頭位置から後方へ、実際に線路が敷かれている中心線を辿るポリラインを作る。
 * 返り値は head→tail の順で、carPositions の弧長サンプリングにそのまま使える。
 *
 * 注意: head は progress > 0.5 のとき「次のセルの曲線の前半」に乗っている。
 * そこを飛ばして現在セルから辿り始めると、progress が 0.5 を跨ぐ瞬間に
 * ポリラインの弧長が半セルぶん飛び、後続車の位置と向きが一気にずれる。
 * head がどのセルの曲線上にいるかで場合分けして繋ぐ必要がある。
 */
export function curvedTrainPolyline(input: TrainPolylineInput): Pt[] {
  const { head, grid, prevGrid, progress, route, history } = input;
  const samples = input.samples ?? 4;

  const points: Pt[] = [head];
  const next = route[0] ?? null;
  const nextNext = route[1] ?? null;

  if (next && progress > 0.5) {
    // head は next セルの曲線上(t = progress - 0.5)。まず next セルを t=0 まで戻り、
    // 続けて現在セル(grid)を t=1→0 で辿る。
    emitCurve(points, grid, next, nextNext, progress - 0.5, 0, samples);
    emitCurve(points, prevGrid, grid, next, 1, 0, samples);
  } else {
    // head は grid セルの曲線上(t = 0.5 + progress)
    emitCurve(points, prevGrid, grid, next, 0.5 + progress, 0, samples);
  }

  // history[0] は grid 自身なので消化済み。以降を古い方へ辿る。
  for (let i = 1; i < history.length; i++) {
    emitCurve(points, history[i + 1] ?? null, history[i], history[i - 1], 1, 0, samples);
  }

  return points;
}
