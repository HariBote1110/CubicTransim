import { toKey, DIR } from '../utils';
import type { CellData } from '../types';
import type { SimWorld } from './simulation';
import { releaseAllOf, tryReserve, reservationKey } from './reservation';

// layer省略(または0)は地平。立体交差の高架側(upper)への置き直しは扱わない
// (橋桁の上下どちらに置いたつもりかをユーザー操作から一意に決める手段が無く、
// 誤って橋の下の線路に列車を挟み込むと余計に厄介なデッドロックになるため。
// 単純に「upperを持つセル(橋桁)には置けない」というルールにする)。
type Grid = { x: number; z: number };

// セルを辿る際に試す方向の順序(北から時計回り)。決定的に1つを選ぶための固定順。
const EXTEND_DIRECTIONS = [
  { x: 0, z: -1, dir: DIR.N },
  { x: 1, z: -1, dir: DIR.NE },
  { x: 1, z: 0, dir: DIR.E },
  { x: 1, z: 1, dir: DIR.SE },
  { x: 0, z: 1, dir: DIR.S },
  { x: -1, z: 1, dir: DIR.SW },
  { x: -1, z: 0, dir: DIR.W },
  { x: -1, z: -1, dir: DIR.NW },
];

const isRailLike = (cell: CellData | undefined): boolean =>
  !!cell && (cell.type === 'rail' || cell.type === 'station' || cell.type === 'depot');

/**
 * headCellを先頭にして、trainId(train.cars両ぶん)を置ける連続した線路セル列を求める。
 * 置けなければnull。置ける場合は先頭から最後尾へ向かうセル列(length === cars)を返す。
 *
 * 条件:
 *   - 全セルが線路(rail/station/depot)であること
 *   - upper(立体交差の橋桁)を持つセルには置けない(上記コメント参照)
 *   - 連続するセル同士がconnectionsで繋がっていること(辿る方向は固定順で決定的に選ぶ)
 *   - 他列車が予約しているセルが含まれていないこと(自分自身の予約は無視する)
 */
export function canPlaceTrainAt(
  world: SimWorld,
  trainId: string,
  headCell: Grid
): Grid[] | null {
  const train = world.trains.find(t => t.id === trainId);
  if (!train) return null;
  const carCount = train.cars ?? 2;
  const railMap = world.railMap;
  const reservations = world.reservations;

  const headKey = toKey(headCell.x, headCell.z);
  const headData = railMap.get(headKey);
  if (!isRailLike(headData) || headData!.upper) return null;

  const cells: Grid[] = [{ x: headCell.x, z: headCell.z }];
  const visited = new Set<string>([headKey]);
  let current = { x: headCell.x, z: headCell.z };

  for (let i = 1; i < carCount; i++) {
    const currentData = railMap.get(toKey(current.x, current.z));
    const connections = currentData?.connections ?? 0;
    let next: Grid | null = null;
    for (const d of EXTEND_DIRECTIONS) {
      if ((connections & d.dir) === 0) continue;
      const nx = current.x + d.x;
      const nz = current.z + d.z;
      const nKey = toKey(nx, nz);
      if (visited.has(nKey)) continue;
      const nData = railMap.get(nKey);
      if (!isRailLike(nData) || nData!.upper) continue;
      next = { x: nx, z: nz };
      break;
    }
    if (!next) return null; // 編成長ぶんの連続した線路が確保できない
    cells.push(next);
    visited.add(toKey(next.x, next.z));
    current = next;
  }

  if (reservations) {
    for (const c of cells) {
      const owner = reservations.get(reservationKey(c));
      if (owner && owner !== trainId) return null;
    }
  }

  return cells;
}

/**
 * デッドロックした列車を、headCellを先頭にした位置へ強制的に置き直す(プラレールを
 * 持ち上げて別の線路へ置き直す操作)。置ければtrue、置けなければfalse(world不変)。
 *
 * 置き直し後はroute/reservedEndIndexをリセットするため、次のstepTrain呼び出しで
 * 経路が再検索される(既存の「経路が空なら探索する」挙動に乗る)。
 */
export function relocateTrain(world: SimWorld, trainId: string, headCell: Grid): boolean {
  const train = world.trains.find(t => t.id === trainId);
  const rt = world.runtimes.get(trainId);
  if (!train || !rt) return false;

  const cells = canPlaceTrainAt(world, trainId, headCell);
  if (!cells) return false;

  if (!world.reservations) world.reservations = new Map();
  releaseAllOf(world.reservations, trainId);

  const carCount = train.cars ?? 2;
  rt.trail = cells;
  const historyCap = carCount + 2;
  const pathHistory = [...cells];
  const tail = pathHistory[pathHistory.length - 1];
  while (pathHistory.length < historyCap) pathHistory.push({ x: tail.x, z: tail.z });
  rt.pathHistory = pathHistory;

  rt.grid = cells[0];
  // prevGridはあえてnullにする(進入方向の制約を外す)。canPlaceTrainAtが辿った
  // trailの向きを進行方向の制約として引き継ぐと、たまたま経路の逆側を向いて
  // 置かれた場合に、置き直し直後の経路探索(直進しか許さない)が閉塞済みの自セルへ
  // 戻れず経路なしになってしまう(ホーム外で方向制約を外す既存箇所と同じ扱い)。
  rt.prevGrid = null;
  rt.route = [];
  rt.reservedEndIndex = -1;
  rt.speedKmh = 0;
  rt.progress = 0;
  rt.stopRemaining = 0;
  rt.pendingDepartureFrom = null;
  rt.renderPos = { x: cells[0].x, y: 0.5, z: cells[0].z };
  rt.renderTarget = null;

  // 新しい位置を物理占有として予約する(他列車が置き直し直後に同じセルへ入らないように)。
  tryReserve(world.reservations, trainId, cells);

  return true;
}
