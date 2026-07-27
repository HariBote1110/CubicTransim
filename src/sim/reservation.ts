import { toKey } from '../utils';
import type { CellData } from '../types';

// layer省略(または0)は地平、1は立体交差の高架側。列車自体には層を持たせず、
// 「そのセルにどちら向きで入ったか」から導出した値をここに載せて使う。
export type Grid = { x: number; z: number; layer?: 0 | 1 };

// PBS(経路予約ベース運行)風の予約テーブル。1セル1列車の排他をセル単位で管理する
// (トラック方向単位までは踏み込まず簡略化。既存の閉塞判定もセル単位のため整合する)。
// 立体交差の地平と高架は別の閉塞資源になるよう、キーに層を含める(地平は従来通り
// "x,z"、高架は"x,z:u")。これにより2本の列車が同じ(x,z)を異なる層で同時に
// 予約できる(立体交差の要点)。
export type ReservationMap = Map<string, string>;

export const reservationKey = (c: Grid) => (c.layer === 1 ? `${c.x},${c.z}:u` : toKey(c.x, c.z));

// 指定セル群をtrainIdのために取得する。1つでも他列車が保有していれば全体を諦める
// (OpenTTDのTryReserveRailTrackが失敗時に途中まで取った予約をロールバックするのと同義)。
export function tryReserve(reservations: ReservationMap, trainId: string, cells: Grid[]): boolean {
  for (const c of cells) {
    const owner = reservations.get(reservationKey(c));
    if (owner && owner !== trainId) return false;
  }
  for (const c of cells) {
    reservations.set(reservationKey(c), trainId);
  }
  return true;
}

// 単一セルの予約を解放する(誰の予約であっても無条件に外す)。
export function releaseCell(reservations: ReservationMap, cell: Grid): void {
  reservations.delete(reservationKey(cell));
}

// 指定列車が保有する予約をすべて解放する(反転時・列車消滅時などに使用)。
export function releaseAllOf(reservations: ReservationMap, trainId: string): void {
  for (const [key, owner] of reservations) {
    if (owner === trainId) reservations.delete(key);
  }
}

// 予約が現在誰のものかを問わず強制的にtrainIdへ割り当てる(セーブロード直後の
// bootstrap用。既存のtrail=物理占有セルを予約テーブルへ再構築する場合に使う)。
export function forceAssign(reservations: ReservationMap, trainId: string, cells: Grid[]): void {
  for (const c of cells) {
    reservations.set(reservationKey(c), trainId);
  }
}

const popcount = (n: number) => {
  let c = 0;
  let v = n;
  while (v) {
    c += v & 1;
    v >>= 1;
  }
  return c;
};

// セルが分岐点(接続方向3以上)かどうか。分岐点そのものはsafe waiting pointにしない
// (分岐点上に停止して塞いだまま待つことはない)。
const isJunction = (cell: CellData | undefined): boolean => popcount(cell?.connections ?? 0) >= 3;

// セルcellがsafe waiting point(そこで安全に停止して次の予約取得を待てる地点)かどうかを
// 判定する。nextはcellの次に進むセル(route上の次要素。終端ならnull)。
// 条件(OpenTTDのPBSと同じ方針: 待機が許されるのは信号・駅・車庫・行き止まりのみ):
//   - 分岐点そのもの -> 不可(分岐点上で待たない)
//   - 車庫セル -> 可
//   - 駅セル -> 可(目的駅の停止位置。経路末尾は必ず駅セルまたはホーム延長セルになる)
//   - 次セルが信号セル(=信号の手前。信号がその先を防護している)-> 可
//   - 次セルが無い(行き止まり) -> 可
//   - それ以外 -> 不可
//
// 「次セルが分岐点なら手前は安全点」という規則は廃止した。単線の共有区間の
// 両端で対向列車がそれぞれ分岐点の手前まで予約を取り、互いに相手の区間へ
// 予約を延長できずに永久に睨み合う(デッドロックする)ため。信号の無い交換設備
// では待機できず、その手前で足止めされたままになる— これは意図した挙動で、
// 交換設備(passing loop)には両端に信号を置く必要がある(OpenTTDと同じ仕様)。
export function isSafeWaitingPoint(
  railMap: Map<string, CellData>,
  cell: Grid,
  next: Grid | null
): boolean {
  const cellData = railMap.get(toKey(cell.x, cell.z));
  const nextData = next ? railMap.get(toKey(next.x, next.z)) : undefined;
  // 立体交差セル(upperを持つ)の上では待機させない。高架の上で止まると
  // 下の線路も含めて配線が読みづらく、実用上も好ましくないため。
  if (cellData?.upper) return false;
  // 次セルが信号セルなら、信号がその先を防護しているため、cell自身が分岐点で
  // あっても安全点として扱う(交換設備の分岐直後に信号を置く構成を想定)。
  if (nextData?.signalDir) return true;
  if (isJunction(cellData)) return false;
  if (cellData?.type === 'depot') return true;
  if (cellData?.type === 'station') return true;
  if (!next) return true;
  return false;
}

// route(次セルから目的地までの経路)のうち、startIdxから走査して最初に見つかる
// safe waiting pointのindexを返す。route末尾は必ず駅停止セル(またはそれに準ずる
// 安全点)なので、見つからなければroute.length-1を返す(=区間全体を予約対象にする)。
export function findSafeSegmentEnd(
  railMap: Map<string, CellData>,
  route: Grid[],
  startIdx: number
): number {
  for (let i = startIdx; i < route.length; i++) {
    const next = i + 1 < route.length ? route[i + 1] : null;
    if (isSafeWaitingPoint(railMap, route[i], next)) return i;
  }
  return route.length - 1;
}

// 経路のうち「出庫してよい」と言える末端のindex。
//
// 車庫から出るときは、途中の何でもない安全点(次が分岐点、など)で止まれることを
// もって出庫してしまうと、駅の手前の本線上に居座って後続を塞ぐ。OpenTTDで
// 車庫からの発車が「次の信号まで経路を取れたときだけ」なのと同じく、
//   - 次のセルが信号セル(信号がその先を防護している)
//   - 経路の末尾(目的駅の停止位置)
// のどちらかに届くまでを一括で予約する。
export function findDepartureSegmentEnd(
  railMap: Map<string, CellData>,
  route: Grid[]
): number {
  for (let i = 0; i < route.length - 1; i++) {
    const next = route[i + 1];
    if (railMap.get(toKey(next.x, next.z))?.signalDir) return i;
  }
  return route.length - 1;
}
