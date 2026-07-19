import { describe, expect, it } from 'vitest';
import { toKey, DIR } from '../utils';
import type { CellData } from '../types';
import { tryReserve, releaseCell, releaseAllOf, isSafeWaitingPoint, findSafeSegmentEnd } from './reservation';

describe('reservation: 予約テーブルの基本操作', () => {
  it('未予約セル群は取得でき、以後は別列車の取得を拒否する', () => {
    const reservations = new Map<string, string>();
    const cells = [{ x: 0, z: 0 }, { x: 1, z: 0 }];
    expect(tryReserve(reservations, 'A', cells)).toBe(true);
    expect(tryReserve(reservations, 'B', cells)).toBe(false);
  });

  it('一部だけ他列車保有なら全体を取得できない(部分的にロールバックされる)', () => {
    const reservations = new Map<string, string>();
    reservations.set(toKey(1, 0), 'B');
    const cells = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    expect(tryReserve(reservations, 'A', cells)).toBe(false);
    // (0,0)や(2,0)がAのものとして残っていないこと(ロールバック)
    expect(reservations.get(toKey(0, 0))).toBeUndefined();
    expect(reservations.get(toKey(2, 0))).toBeUndefined();
  });

  it('releaseCellで解放したセルは他列車が取得できる', () => {
    const reservations = new Map<string, string>();
    tryReserve(reservations, 'A', [{ x: 0, z: 0 }]);
    releaseCell(reservations, { x: 0, z: 0 });
    expect(tryReserve(reservations, 'B', [{ x: 0, z: 0 }])).toBe(true);
  });

  it('releaseAllOfは指定列車の予約だけを解放する', () => {
    const reservations = new Map<string, string>();
    tryReserve(reservations, 'A', [{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    tryReserve(reservations, 'B', [{ x: 2, z: 0 }]);
    releaseAllOf(reservations, 'A');
    expect(reservations.has(toKey(0, 0))).toBe(false);
    expect(reservations.has(toKey(1, 0))).toBe(false);
    expect(reservations.get(toKey(2, 0))).toBe('B');
  });
});

describe('reservation: safe waiting point判定', () => {
  it('分岐セル(接続3方向以上)は安全ではない', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(1, 0), { type: 'rail', connections: DIR.N | DIR.E | DIR.W });
    expect(isSafeWaitingPoint(railMap, { x: 1, z: 0 }, { x: 2, z: 0 })).toBe(false);
  });

  it('分岐セルの手前(次セルが分岐)は安全(分岐点自体には停止しない)', () => {
    // 分岐点そのものの手前でだけ停止を許可することで、対向列車と予約区間が
    // 分岐点を跨いで丸ごと衝突するのを避け、順番に分岐点を通過できるようにする
    // (分岐点上に停止することはない=isJunction(cell)自体は引き続き不可のまま)。
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(0, 0), { type: 'rail', connections: DIR.E });
    railMap.set(toKey(1, 0), { type: 'rail', connections: DIR.N | DIR.E | DIR.W });
    expect(isSafeWaitingPoint(railMap, { x: 0, z: 0 }, { x: 1, z: 0 })).toBe(true);
  });

  it('車庫セルは安全', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(0, 0), { type: 'depot', connections: DIR.E });
    expect(isSafeWaitingPoint(railMap, { x: 0, z: 0 }, { x: 1, z: 0 })).toBe(true);
  });

  it('駅セルは安全', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(0, 0), { type: 'station', connections: DIR.E, stationId: 's1' });
    expect(isSafeWaitingPoint(railMap, { x: 0, z: 0 }, { x: 1, z: 0 })).toBe(true);
  });

  it('次セルが信号セルなら(信号の手前として)安全', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(0, 0), { type: 'rail', connections: DIR.E });
    railMap.set(toKey(1, 0), { type: 'rail', connections: DIR.E | DIR.W, signalDir: DIR.E });
    expect(isSafeWaitingPoint(railMap, { x: 0, z: 0 }, { x: 1, z: 0 })).toBe(true);
  });

  it('行き止まり(次セルが無い)は安全', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(0, 0), { type: 'rail', connections: 0 });
    expect(isSafeWaitingPoint(railMap, { x: 0, z: 0 }, null)).toBe(true);
  });

  it('findSafeSegmentEndはroute中の最初の安全点indexを返す', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(0, 0), { type: 'rail', connections: DIR.E | DIR.W });
    railMap.set(toKey(1, 0), { type: 'rail', connections: DIR.E | DIR.W, signalDir: DIR.E });
    railMap.set(toKey(2, 0), { type: 'rail', connections: DIR.E | DIR.W });
    railMap.set(toKey(3, 0), { type: 'station', connections: DIR.W, stationId: 's1' });
    const route = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }];
    // route[0]=(0,0)の次は(1,0)=信号セル -> index0が安全点
    expect(findSafeSegmentEnd(railMap, route, 0)).toBe(0);
    // index1以降で探すと、次に安全なのは駅セル(index3)
    expect(findSafeSegmentEnd(railMap, route, 1)).toBe(3);
  });
});
