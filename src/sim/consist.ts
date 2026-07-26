import type { TrainRuntime } from './simulation';

export interface CarPosition {
  x: number;
  z: number;
  heading: { x: number; z: number };
}

const normalize = (x: number, z: number) => {
  const len = Math.sqrt(x * x + z * z);
  if (len < 1e-9) return { x: 0, z: 1 };
  return { x: x / len, z: z / len };
};

// 先頭(runtime.renderPos)からpathHistory(過去に通過したセル中心列)を辿るポリラインに沿って、
// 弧長 k×spacing だけ後方の点をサンプリングする。ポリラインが足りない(pathHistoryが短い)場合は
// 最後の点にクランプする。headingはそのサンプル点が乗っているセグメントの向き(正規化済み)。
export function carPositions(rt: TrainRuntime, cars: number, spacing = 1.0): CarPosition[] {
  const poly: { x: number; z: number }[] = [rt.renderPos, ...rt.pathHistory];

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

  const sampleAt = (dist: number): CarPosition => {
    let remaining = dist;
    for (let i = 0; i < segLengths.length; i++) {
      const segLen = segLengths[i];
      const isLastSeg = i === segLengths.length - 1;
      if (remaining <= segLen || isLastSeg) {
        const t = segLen > 1e-9 ? Math.min(1, Math.max(0, remaining / segLen)) : 0;
        const a = poly[i];
        const b = poly[i + 1];
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const heading = normalize(b.x - a.x, b.z - a.z);
        return { x, z, heading };
      }
      remaining -= segLen;
    }
    // ポリラインが1点しかない(pathHistoryが空)場合
    const only = poly[0];
    return { x: only.x, z: only.z, heading: { x: 0, z: 1 } };
  };

  const result: CarPosition[] = [];
  for (let k = 0; k < cars; k++) {
    result.push(sampleAt(k * spacing));
  }
  return result;
}
