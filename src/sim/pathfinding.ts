import { toKey, DIR, getVectorFromDir } from '../utils';
import type { CellData, StationData } from '../types';

export interface RouteQuery {
  start: { x: number; z: number };
  prev: { x: number; z: number } | null;
  targetStationId: string;
  // 編成両数。停車位置(先頭車の停止セル)を「編成中央がホーム中央に最も近づく位置」
  // に決めるために使う(headIdx計算)。
  cars: number;
  // 停車位置設定(OpenTTD流のNear/Middle/Far)。省略時は'middle'(既存の編成中央基準)。
  // ただし編成長(cars) >= ホーム長(P)の場合はこの設定によらず無条件でFarEnd(奥端)固定になる。
  stopLocation?: 'near' | 'middle' | 'far';
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

// 停止位置(セル単位の連続量)の端数判定に使う許容誤差。
const STOP_POS_EPSILON = 1e-9;

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

export interface RouteResult {
  path: { x: number; z: number }[];
  /**
   * 経路末尾セルへの最終区間のうち、先頭車が実際に停止する位置(0<f<=1)。
   * 1 は従来どおり「末尾セルの中心で停車」、0.5 なら「末尾セル中心の半セル手前で停車」。
   * 停止位置をセル中心に量子化せず、ホーム中央と編成中央を正確に合わせるために使う。
   */
  stopProgress: number;
}

// 目的駅セルに到達した経路を、OpenTTD流のGetTrainStopLocation相当の停止位置まで延長する。
// ホームセル列(進行方向に連続する同一stationIdのセル、進入順に0..P-1、entry=lastCellが
// index0)に対し、先頭車の停止位置 headPos(セル単位の連続量)を次の優先順位で決める:
//   1. 編成長(cars) >= ホーム長(P) なら stopLocation設定によらず無条件で FarEnd(headPos=P-1)固定
//   2. それ以外は stopLocation ('near'|'middle'|'far') に従う
//      near:   headPos = min(cars,P) - 1 (編成ができるだけホーム内に収まる最小前進)
//      middle: headPos = (P+cars)/2 - 1  (編成中央がホーム中央と一致する連続量)
//      far:    headPos = P - 1 (ホーム奥端)
// headPosは常にP-1以下になるため、ホームより先へ延長することはない(FarEndは
// あくまで「ホーム奥端で止まる」処理であり、ホームの先の線路まで出て行くわけではない)。
//
// middleのheadPosは半端値(x.5)になり得る。従来はこれをceilで切り上げてセル中心に
// 量子化していたため、P+carsが奇数のとき編成が半セル(=15m)ホーム奥へ寄っていた。
// ここでは切り上げたセルまで経路を延ばしたうえで、その最終区間の途中(stopProgress)で
// 停車させることで、量子化誤差なくホーム中央に合わせる。
const extendThroughPlatform = (
  railMap: Map<string, CellData>,
  targetId: string,
  lastCell: { x: number; z: number },
  prevCell: { x: number; z: number } | null,
  path: { x: number; z: number }[],
  cars: number,
  stopLocation: 'near' | 'middle' | 'far' = 'middle'
): RouteResult => {
  const extended = [...path];
  if (!prevCell) return { path: extended, stopProgress: 1 };

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
  // OpenTTD流: 編成長(cars) >= ホーム長(P)なら停止位置はstopLocation設定によらず
  // 無条件でFarEnd(奥端)固定になる。それ以外はNear/Middle/Farのオーダー設定に従う。
  let headPos: number;
  if (cars >= P) {
    headPos = P - 1;
  } else if (stopLocation === 'near') {
    headPos = Math.min(cars, P) - 1;
  } else if (stopLocation === 'far') {
    headPos = P - 1;
  } else {
    headPos = (P + cars) / 2 - 1;
  }

  // headPosは常にP-1以下になる(cars>=Pの場合はFarEnd固定でheadPos=P-1、near/far/middleの
  // いずれもcars<Pのときはホーム内に収まる)。そのため、ホームの先の線路まで停止位置を
  // 延長する必要はない(=FarEndは「ホーム奥端で止まる」のであり、それより先には出ない)。
  //
  // 経路は headPos を含む最小のセル(=切り上げ)まで延ばし、端数は stopProgress で表す。
  const headCell = Math.ceil(headPos - STOP_POS_EPSILON);
  for (let i = 1; i <= headCell; i++) extended.push(platformCells[i]);

  const remainder = headCell - headPos;
  const stopProgress = remainder <= STOP_POS_EPSILON ? 1 : 1 - remainder;
  return { path: extended, stopProgress };
};

/**
 * 経路と停止位置(最終区間内の端数)をまとめて返す版。
 * 停止位置の端数を必要としない呼び出し側のために、pathのみを返す calculateRoute も残す。
 */
export function calculateRouteWithStop(
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  occupied: Set<string>,
  reserved: Set<string>,
  query: RouteQuery
): RouteResult {
  const { start, prev: prevGrid, targetStationId: targetId, cars, stopLocation = 'middle' } = query;

  const targetSt = stations.get(targetId);
  if (!targetSt) return { path: [], stopProgress: 1 };

  const runSearch = (ignoreOccupied: boolean) => {
      const queue = [{ curr: start, path: [] as { x: number; z: number }[], prev: prevGrid }];
      const visited = new Set<string>();
      visited.add(toKey(start.x, start.z));
      const MAX_DEPTH = 300;

      while (queue.length > 0) {
          const { curr, path, prev } = queue.shift()!;
          const currKey = toKey(curr.x, curr.z);
          const cell = railMap.get(currKey);

          if (cell && cell.stationId === targetId) return extendThroughPlatform(railMap, targetId, curr, prev, path, cars, stopLocation);
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
  return fallbackPath || { path: [], stopProgress: 1 };
}

export function calculateRoute(
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  occupied: Set<string>,
  reserved: Set<string>,
  query: RouteQuery
): { x: number; z: number }[] {
  return calculateRouteWithStop(railMap, stations, occupied, reserved, query).path;
}
