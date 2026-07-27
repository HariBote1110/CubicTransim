import type { TrainRuntime } from './simulation';
import { curvedTrainPolyline } from './trackPath';

export interface CarPosition {
  x: number;
  z: number;
  /**
   * 描画高さ。立体交差の高架を走行中はrt.renderPos.yが底上げされる(simulation.tsの
   * heightForLayer/interpHeightForLayerを参照)。ここでは編成全体で同じ高さを使う
   * 簡略化をしている(各車両ごとの層をpathHistoryへ持たせていないため)。立体交差は
   * 1セルだけの短い区間なので、実用上は編成中央付近が高架に乗っている間だけ
   * 全車両が一括で持ち上がる/下がる形になる。より精密に台車ごとの高さを
   * 出したい場合は、pathHistoryに層情報を追加してこの関数を拡張すること。
   */
  y: number;
  heading: { x: number; z: number };
}

const normalize = (x: number, z: number) => {
  const len = Math.sqrt(x * x + z * z);
  if (len < 1e-9) return { x: 0, z: 1 };
  return { x: x / len, z: z / len };
};

/**
 * 車体の向きを求めるために前後の台車をサンプリングする間隔(弧長、セル単位)の半分。
 * 車体長0.86に対して前後の台車が±0.35に付いているイメージ。
 */
export const BOGIE_HALF_SPACING = 0.35;

// 先頭(runtime.renderPos)からpathHistory(過去に通過したセル中心列)を辿るポリラインに沿って、
// 弧長 k×spacing だけ後方の点をサンプリングする。ポリラインが足りない(pathHistoryが短い)場合は
// 最後の点にクランプする。
//
// headingは「そのサンプル点が乗っているセグメントの向き」ではなく、前後の台車位置
// (弧長 ±BOGIE_HALF_SPACING)を結んだ向きから求める。セグメントの向きをそのまま使うと
// ポリラインの折れ点(セル境界)を跨いだ瞬間に向きが階段状に飛び、斜め線路と直線の
// 変わり目で車両がガクッと回って見えていた。前後2点方式なら、前台車が先に曲がって
// 後台車が追いつくまでの間に向きが連続的に変わるため、実車と同じ挙動になる。
export function carPositions(rt: TrainRuntime, cars: number, spacing = 1.0): CarPosition[] {
  // 通過済みセルを結ぶ折れ線ではなく、実際に線路が敷かれている中心線(セル曲線)を辿る。
  // 折れ線のままだとカーブで後続車がレールの外側へ膨らんで見える。
  const poly: { x: number; z: number }[] = curvedTrainPolyline({
    head: rt.renderPos,
    grid: rt.grid,
    prevGrid: rt.prevGrid,
    progress: rt.progress,
    route: rt.route,
    history: rt.pathHistory,
  });

  // 端数停車(セル中心の手前で停止)では rt.grid = 到達セル、renderPos = その手前、
  // という状態になるため pathHistory[0] が renderPos の「前方」に来る。
  // そのままだと折り返しのあるポリラインになり、弧長サンプリングが破綻して
  // 後続車が前へめり込む。先頭が前進→後退と反転している場合は、その前方の点を落とす。
  while (poly.length >= 3) {
    const a = { x: poly[1].x - poly[0].x, z: poly[1].z - poly[0].z };
    const b = { x: poly[2].x - poly[1].x, z: poly[2].z - poly[1].z };
    if (a.x * b.x + a.z * b.z >= 0) break;
    poly.splice(1, 1);
  }

  const segLengths: number[] = [];
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    segLengths.push(Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2));
  }

  const totalLength = segLengths.reduce((s, l) => s + l, 0);

  // ポリラインの末端の向き(後方へ延長するときに使う)。
  // 長さ0のセグメントは向きが求まらないので、後ろから見て最初の非退化セグメントを採る。
  const tailDirection = (() => {
    for (let i = segLengths.length - 1; i >= 0; i--) {
      if (segLengths[i] > 1e-9) {
        const a = poly[i];
        const b = poly[i + 1];
        return normalize(b.x - a.x, b.z - a.z);
      }
    }
    return { x: 0, z: -1 };
  })();

  // ポリライン上の、先頭から弧長distだけ後方の点。
  // 履歴が足りない場合は末端で止めるのではなく、末端の向きへ直線で延長する。
  // 止めてしまうと、発車直後(pathHistoryがまだ短い)に後続車が始点へ団子状に
  // 積み重なり、履歴が伸びた瞬間に所定位置へ飛ぶ。
  const pointAt = (dist: number): { x: number; z: number } => {
    let remaining = Math.max(0, dist);
    if (remaining > totalLength) {
      const over = remaining - totalLength;
      const end = poly[poly.length - 1];
      return { x: end.x + tailDirection.x * over, z: end.z + tailDirection.z * over };
    }
    for (let i = 0; i < segLengths.length; i++) {
      const segLen = segLengths[i];
      const isLastSeg = i === segLengths.length - 1;
      if (remaining <= segLen || isLastSeg) {
        const t = segLen > 1e-9 ? Math.min(1, Math.max(0, remaining / segLen)) : 0;
        const a = poly[i];
        const b = poly[i + 1];
        return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      }
      remaining -= segLen;
    }
    // ポリラインが1点しかない(pathHistoryが空)場合
    return { x: poly[0].x, z: poly[0].z };
  };

  const result: CarPosition[] = [];
  for (let k = 0; k < cars; k++) {
    const centreDist = k * spacing;
    const centre = pointAt(centreDist);
    // 前台車は先頭より前には出せないので0でクランプする。クランプされていても
    // 両端の点はポリラインに沿って連続に動くため、向きは飛ばない。
    const front = pointAt(Math.max(0, centreDist - BOGIE_HALF_SPACING));
    const rear = pointAt(centreDist + BOGIE_HALF_SPACING);
    result.push({
      x: centre.x,
      z: centre.z,
      y: rt.renderPos.y,
      heading: normalize(front.x - rear.x, front.z - rear.z),
    });
  }
  return result;
}
