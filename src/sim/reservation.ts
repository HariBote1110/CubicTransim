import { toKey } from '../utils';
import type { CellData } from '../types';

export type Grid = { x: number; z: number };

// PBS(経路予約ベース運行)風の予約テーブル。1セル1列車の排他をセル単位で管理する
// (トラック方向単位までは踏み込まず簡略化。既存の閉塞判定もセル単位のため整合する)。
export type ReservationMap = Map<string, string>;

export const reservationKey = (c: Grid) => toKey(c.x, c.z);

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
// 条件(openttd-source-notes A-1 / 設計文書 準拠、1セル粒度への簡略化):
//   - 分岐点そのもの -> 不可(分岐点上で待たない)
//   - 車庫セル -> 可
//   - 駅セル -> 可(目的駅の停止位置。経路末尾は必ず駅セルまたはホーム延長セルになる)
//   - 次セルが信号セル(=信号の手前。信号は分岐点の直後に置かれることもあるため、
//     分岐点の直前でも信号が守っていれば安全点として扱う)-> 可
//   - 次セルが無い(行き止まり) -> 可
//   - それ以外(次セルも分岐点でなく、信号も無いただの直線区間)-> 不可
//     (次セルが分岐点の場合、信号が無ければ不可のまま=分岐点の直前で漫然と
//     待つことは避ける)
export function isSafeWaitingPoint(
  railMap: Map<string, CellData>,
  cell: Grid,
  next: Grid | null
): boolean {
  const cellData = railMap.get(toKey(cell.x, cell.z));
  const nextData = next ? railMap.get(toKey(next.x, next.z)) : undefined;
  // 次セルが信号セルなら、信号がその先を防護しているため、cell自身が分岐点で
  // あっても安全点として扱う(交換設備の分岐直後に信号を置く構成を想定)。
  if (nextData?.signalDir) return true;
  if (isJunction(cellData)) return false;
  if (cellData?.type === 'depot') return true;
  if (cellData?.type === 'station') return true;
  if (!next) return true;
  // 次セルが分岐点の手前で待つ(分岐点自体には進入・停止しない)。分岐を1区間ごとに
  // 細かく区切ることで、対向列車と予約区間が丸ごと衝突するのを避け、双方が
  // 順番に分岐点を通過できるようにする。
  if (isJunction(nextData)) return true;
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
