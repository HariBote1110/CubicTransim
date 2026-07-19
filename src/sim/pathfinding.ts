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

          if (cell && cell.stationId === targetId) return path;
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
