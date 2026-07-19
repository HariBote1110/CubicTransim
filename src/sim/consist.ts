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
