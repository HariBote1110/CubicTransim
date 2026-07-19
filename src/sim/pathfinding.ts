import { toKey, DIR, getVectorFromDir } from '../utils';
import type { CellData, StationData } from '../types';

export interface RouteQuery {
  start: { x: number; z: number };
  prev: { x: number; z: number } | null;
  targetStationId: string;
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

// 目的駅セルに到達した経路を、進行方向に連続する同一stationIdのセルが続く限り延長する。
// これにより先頭車はホームの奥端まで進んでから停車するようになる(編成全体がホームへ載る)。
// 急カーブ制約(内積>=0.5)を満たす直進方向のみを辿り、分岐がある場合は最も直進に近い
// (内積が最大の)候補を優先し、そのような候補が無ければ延長を終える。
const extendThroughPlatform = (
  railMap: Map<string, CellData>,
  targetId: string,
  lastCell: { x: number; z: number },
  prevCell: { x: number; z: number } | null,
  path: { x: number; z: number }[]
): { x: number; z: number }[] => {
  const extended = [...path];
  let curr = lastCell;
  let prev = prevCell;

  while (prev) {
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
      if (!nextCell || nextCell.stationId !== targetId) continue;

      if (!best || score > best.score) best = { x: tx, z: tz, score };
    }

    if (!best) break;
    extended.push({ x: best.x, z: best.z });
    prev = curr;
    curr = { x: best.x, z: best.z };
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
  const { start, prev: prevGrid, targetStationId: targetId } = query;

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

          if (cell && cell.stationId === targetId) return extendThroughPlatform(railMap, targetId, curr, prev, path);
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
