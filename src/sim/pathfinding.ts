import { toKey, DIR, getVectorFromDir } from '../utils';
import type { CellData, StationData } from '../types';

export interface RouteQuery {
  start: { x: number; z: number };
  prev: { x: number; z: number } | null;
  targetStationId: string;
  // 編成両数。停車位置(先頭車の停止セル)を「編成中央がホーム中央に最も近づく位置」
  // に決めるために使う(headIdx計算)。
  cars: number;
}

const normalize = (x: number, z: number) => {
  const len = Math.sqrt(x * x + z * z);
  const d = len || 1;
  return { x: x / d, z: z / d };
};

const dot = (a: { x: number; z: number }, b: { x: number; z: number }) => a.x * b.x + a.z * b.z;

// 2Dの符号付き外積。座標系は x+=東, z+=南。この値が大きい(正の)候補ほど
// 進行方向(dv)に対して「進行方向左側」に寄る候補とみなす(このゲームの座標系・
// カメラ視点における左側の定義。日本式の左側通行をデフォルトにするため、
// 同距離の並行経路がある場合はこの順にBFSキューへ積んで先に採用させる)。
const leftwardness = (dv: { x: number; z: number }, d: { x: number; z: number }) => dv.x * d.z - dv.z * d.x;

const EXTEND_DIRECTIONS = [
    { x: 0, z: -1, dir: DIR.N }, { x: 1, z: -1, dir: DIR.NE },
    { x: 1, z: 0, dir: DIR.E }, { x: 1, z: 1, dir: DIR.SE },
    { x: 0, z: 1, dir: DIR.S }, { x: -1, z: 1, dir: DIR.SW },
    { x: -1, z: 0, dir: DIR.W }, { x: -1, z: -1, dir: DIR.NW }
];

// curr(直前セルprevから直進してきた)から、急カーブ制約(内積>=0.5)を満たす直進方向のうち
// acceptを満たす次セルを探す。複数候補があれば最も直進に近い(内積が最大の)ものを選ぶ。
const findNextInLine = (
  railMap: Map<string, CellData>,
  curr: { x: number; z: number },
  prev: { x: number; z: number },
  accept: (cell: CellData | undefined) => boolean
): { x: number; z: number; score: number } | null => {
  const cellData = railMap.get(toKey(curr.x, curr.z));
  const connections = cellData?.connections || 0;
  const cv = normalize(curr.x - prev.x, curr.z - prev.z);

  let best: { x: number; z: number; score: number } | null = null;
  for (const d of EXTEND_DIRECTIONS) {
    if ((connections & d.dir) === 0) continue;
    const tx = curr.x + d.x;
    const tz = curr.z + d.z;
    if (tx === prev.x && tz === prev.z) continue;

    const nv = normalize(d.x, d.z);
    const score = dot(cv, nv);
    if (score < 0.5) continue;

    const nextCell = railMap.get(toKey(tx, tz));
    if (!accept(nextCell)) continue;

    if (!best || score > best.score) best = { x: tx, z: tz, score };
  }
  return best;
};

// 目的駅セルに到達した経路を、「編成中央がホーム中央に(セル単位で)最も近づく」先頭車の
// 停止セルまで延長する。ホームセル列(進行方向に連続する同一stationIdのセル、進入順に
// 0..P-1、entry=lastCellがindex0)に対し、headIdx = ceil((P+cars)/2) - 1 を停止目標とする。
// headIdxがホーム内(<=P-1)ならホーム内のそのセルで止める。ホームを超える場合は、
// 直進方向に存在する線路/駅セル(stationIdは問わない)をさらに辿って延長し、
// 線路が尽きた場合はそこでクランプする(headIdxに届かなくてもよい)。
const extendThroughPlatform = (
  railMap: Map<string, CellData>,
  targetId: string,
  lastCell: { x: number; z: number },
  prevCell: { x: number; z: number } | null,
  path: { x: number; z: number }[],
  cars: number
): { x: number; z: number }[] => {
  const extended = [...path];
  if (!prevCell) return extended;

  // Phase 0: ホームセル列(P個、entry=index0)を先読みする。
  const platformCells: { x: number; z: number }[] = [lastCell];
  {
    let curr = lastCell;
    let prev = prevCell;
    while (true) {
      const best = findNextInLine(railMap, curr, prev, (c) => !!c && c.stationId === targetId);
      if (!best) break;
      platformCells.push({ x: best.x, z: best.z });
      prev = curr;
      curr = { x: best.x, z: best.z };
    }
  }

  const P = platformCells.length;
  const headIdx = Math.ceil((P + cars) / 2) - 1;

  if (headIdx <= P - 1) {
    for (let i = 1; i <= headIdx; i++) extended.push(platformCells[i]);
    return extended;
  }

  // ホーム全体を延長した上で、さらにホームの先へ延長する。
  for (let i = 1; i < P; i++) extended.push(platformCells[i]);

  let extra = headIdx - (P - 1);
  let curr = platformCells[P - 1];
  let prev = P >= 2 ? platformCells[P - 2] : prevCell;
  while (extra > 0) {
    const best = findNextInLine(railMap, curr, prev, (c) => !!c);
    if (!best) break; // 線路が尽きたのでクランプする
    extended.push({ x: best.x, z: best.z });
    prev = curr;
    curr = { x: best.x, z: best.z };
    extra--;
  }

  return extended;
};

export function calculateRoute(
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  occupied: Set<string>,
  reserved: Set<string>,
  query: RouteQuery
): { x: number; z: number }[] {
  const { start, prev: prevGrid, targetStationId: targetId, cars } = query;

  const targetSt = stations.get(targetId);
  if (!targetSt) return [];

  const runSearch = (ignoreOccupied: boolean) => {
      const queue = [{ curr: start, path: [] as { x: number; z: number }[], prev: prevGrid }];
      const visited = new Set<string>();
      visited.add(toKey(start.x, start.z));
      const MAX_DEPTH = 300;

      while (queue.length > 0) {
          const { curr, path, prev } = queue.shift()!;
          const currKey = toKey(curr.x, curr.z);
          const cell = railMap.get(currKey);

          if (cell && cell.stationId === targetId) return extendThroughPlatform(railMap, targetId, curr, prev, path, cars);
          if (path.length >= MAX_DEPTH) continue;

          const myConnections = cell?.connections || 0;
          const directions = [
              { x: 0, z: -1, dir: DIR.N }, { x: 1, z: -1, dir: DIR.NE },
              { x: 1, z: 0, dir: DIR.E }, { x: 1, z: 1, dir: DIR.SE },
              { x: 0, z: 1, dir: DIR.S }, { x: -1, z: 1, dir: DIR.SW },
              { x: -1, z: 0, dir: DIR.W }, { x: -1, z: -1, dir: DIR.NW }
          ];

          const validMoves = [];
          for (const d of directions) {
              if ((myConnections & d.dir) === 0) continue;
              const tx = curr.x + d.x;
              const tz = curr.z + d.z;
              if (prev && tx === prev.x && tz === prev.z) continue;

              if (prev) {
                  const cv = normalize(curr.x - prev.x, curr.z - prev.z);
                  const nv = normalize(d.x, d.z);
                  if (dot(cv, nv) < 0.5) continue;
              }

              const targetKey = toKey(tx, tz);
              const targetCell = railMap.get(targetKey);
              if (targetCell && targetCell.signalDir) {
                  const sv = getVectorFromDir(targetCell.signalDir);
                  const dv = { x: d.x, z: d.z };
                  if ((sv.x * dv.x + sv.z * dv.z) < -0.1) continue;
              }

              if (!ignoreOccupied) {
                  if (reserved.has(targetKey)) continue;
                  if (occupied.has(targetKey)) continue;
              }

              validMoves.push({ x: tx, z: tz, dx: d.x, dz: d.z });
          }

          // 進行方向がある(prevが存在する)場合、同距離のタイブレークで日本式左側通行を
          // 優先するため「進行方向左側に曲がる/寄る」候補から先にキューへ積む。
          // BFSはFIFOなので、同距離なら先に積んだ左寄りの経路が採用される。
          if (prev) {
              const cv = normalize(curr.x - prev.x, curr.z - prev.z);
              validMoves.sort((a, b) => leftwardness(cv, { x: b.dx, z: b.dz }) - leftwardness(cv, { x: a.dx, z: a.dz }));
          }

          if (validMoves.length === 0 && prev) {
               queue.push({ curr: prev, path: [...path, prev], prev: curr });
          }

          for (const move of validMoves) {
              const key = toKey(move.x, move.z);
              if (!visited.has(key)) {
                  visited.add(key);
                  const cell = { x: move.x, z: move.z };
                  queue.push({ curr: cell, path: [...path, cell], prev: curr });
              }
          }
      }
      return null;
  };

  const smartPath = runSearch(false);
  if (smartPath) return smartPath;
  const fallbackPath = runSearch(true);
  return fallbackPath || [];
}
