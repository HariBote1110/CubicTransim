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

              validMoves.push({ x: tx, z: tz });
          }

          if (validMoves.length === 0 && prev) {
               queue.push({ curr: prev, path: [...path, prev], prev: curr });
          }

          for (const move of validMoves) {
              const key = toKey(move.x, move.z);
              if (!visited.has(key)) {
                  visited.add(key);
                  queue.push({ curr: move, path: [...path, move], prev: curr });
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
