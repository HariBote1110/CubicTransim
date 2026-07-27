import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld } from './simulation';
import { reservationKey } from './reservation';
import { canPlaceTrainAt, relocateTrain } from './relocate';

const buildRailMap = (cells: { x: number; z: number }[]) => {
  const map = new Map<string, CellData>();
  for (let i = 0; i < cells.length - 1; i++) {
    const curr = cells[i];
    const next = cells[i + 1];
    const dx = next.x - curr.x;
    const dz = next.z - curr.z;
    const dir = getDirFromVector(dx, dz);
    const oppDir = getOppositeDir(dir);

    const currKey = toKey(curr.x, curr.z);
    const currCell = map.get(currKey) || { type: 'rail' as const, connections: 0 };
    map.set(currKey, { ...currCell, connections: (currCell.connections || 0) | dir });

    const nextKey = toKey(next.x, next.z);
    const nextCell = map.get(nextKey) || { type: 'rail' as const, connections: 0 };
    map.set(nextKey, { ...nextCell, connections: (nextCell.connections || 0) | oppDir });
  }
  return map;
};

const makeTrain = (overrides: Partial<TrainData>): TrainData => ({
  id: 't1',
  x: 0,
  z: 0,
  schedule: [],
  scheduleIndex: 0,
  status: 'running',
  cars: 2,
  ...overrides,
});

const makeWorld = (
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  trains: TrainData[]
): SimWorld => ({
  railMap, stations, trains, runtimes: new Map(), waiting: new Map(), rng: () => 1,
});

describe('canPlaceTrainAt', () => {
  it('線路でないセルには置けない', () => {
    const railMap = buildRailMap([{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }]);
    const train = makeTrain({ x: 0, z: 0 });
    const world = makeWorld(railMap, new Map(), [train]);
    world.runtimes.set('t1', {
      id: 't1', grid: { x: 0, z: 0 }, prevGrid: null, progress: 0, speedKmh: 0,
      route: [], reservedEndIndex: -1, trail: [{ x: 0, z: 0 }], pathHistory: [{ x: 0, z: 0 }],
      stopRemaining: 0, waitTimer: 0, debugStatus: '', renderPos: { x: 0, y: 0.5, z: 0 },
      renderTarget: null, passengers: 0, lastStopStationId: null, haltRemaining: 0,
    });

    expect(canPlaceTrainAt(world, 't1', { x: 5, z: 5 })).toBeNull();
  });

  it('編成長ぶんの連続した線路が無い場所(行き止まりの直前)には置けない', () => {
    // 0-1-2 の3セルの単線行き止まり。cars=3にすると、セル1を先頭にした場合
    // 先頭+2両=セル1,0,?という並びしか取れず(セル2側は1方向のみ)、
    // 逆にセル0を先頭にすると1,2までしか続かず3両目が無い。
    const railMap = buildRailMap([{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    const train = makeTrain({ x: 0, z: 0, cars: 3 });
    const world = makeWorld(railMap, new Map(), [train]);
    world.runtimes.set('t1', {
      id: 't1', grid: { x: 0, z: 0 }, prevGrid: null, progress: 0, speedKmh: 0,
      route: [], reservedEndIndex: -1, trail: [{ x: 0, z: 0 }], pathHistory: [{ x: 0, z: 0 }],
      stopRemaining: 0, waitTimer: 0, debugStatus: '', renderPos: { x: 0, y: 0.5, z: 0 },
      renderTarget: null, passengers: 0, lastStopStationId: null, haltRemaining: 0,
    });

    expect(canPlaceTrainAt(world, 't1', { x: 0, z: 0 })).toBeNull();
    expect(canPlaceTrainAt(world, 't1', { x: 1, z: 0 })).toBeNull();
  });

  it('他の列車が予約しているセルには置けない', () => {
    const railMap = buildRailMap([{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }]);
    const train = makeTrain({ id: 't1', x: 0, z: 0, cars: 2 });
    const world = makeWorld(railMap, new Map(), [train]);
    world.runtimes.set('t1', {
      id: 't1', grid: { x: 0, z: 0 }, prevGrid: null, progress: 0, speedKmh: 0,
      route: [], reservedEndIndex: -1, trail: [{ x: 0, z: 0 }], pathHistory: [{ x: 0, z: 0 }],
      stopRemaining: 0, waitTimer: 0, debugStatus: '', renderPos: { x: 0, y: 0.5, z: 0 },
      renderTarget: null, passengers: 0, lastStopStationId: null, haltRemaining: 0,
    });
    world.reservations = new Map([
      [reservationKey({ x: 2, z: 0 }), 't2'],
      [reservationKey({ x: 3, z: 0 }), 't2'],
    ]);

    expect(canPlaceTrainAt(world, 't1', { x: 2, z: 0 })).toBeNull();
    // 予約の無い区間には置ける
    expect(canPlaceTrainAt(world, 't1', { x: 0, z: 0 })).toEqual([{ x: 0, z: 0 }, { x: 1, z: 0 }]);
  });
});

describe('relocateTrain', () => {
  const setup = () => {
    // 0-1-2-3-4 の直線。t1はセル0に、t2は関係ないところにいる想定。
    const railMap = buildRailMap([
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ]);
    const train = makeTrain({ id: 't1', x: 0, z: 0, cars: 2 });
    const world = makeWorld(railMap, new Map(), [train]);
    world.runtimes.set('t1', {
      id: 't1', grid: { x: 0, z: 0 }, prevGrid: null, progress: 0.5, speedKmh: 42,
      route: [{ x: 1, z: 0 }], reservedEndIndex: 0,
      trail: [{ x: 0, z: 0 }, { x: -1, z: 0 }], pathHistory: [{ x: 0, z: 0 }, { x: -1, z: 0 }, { x: -1, z: 0 }, { x: -1, z: 0 }],
      stopRemaining: 0, waitTimer: 70, debugStatus: 'Waiting for path...',
      renderPos: { x: 0, y: 0.5, z: 0 }, renderTarget: { x: 1, y: 0.5, z: 0 },
      passengers: 0, lastStopStationId: null, haltRemaining: 0, pendingDepartureFrom: 'stA',
    });
    world.reservations = new Map([
      [reservationKey({ x: 0, z: 0 }), 't1'],
      [reservationKey({ x: -1, z: 0 }), 't1'],
      [reservationKey({ x: 1, z: 0 }), 't1'],
    ]);
    return world;
  };

  it('置き直すとtrail/pathHistoryが新しい位置になり、routeが空・速度0になる', () => {
    const world = setup();
    const ok = relocateTrain(world, 't1', { x: 3, z: 0 });
    expect(ok).toBe(true);

    const rt = world.runtimes.get('t1')!;
    expect(rt.trail).toEqual([{ x: 3, z: 0 }, { x: 4, z: 0 }]);
    expect(rt.pathHistory).toEqual([{ x: 3, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 0 }]);
    expect(rt.route).toEqual([]);
    expect(rt.reservedEndIndex).toBe(-1);
    expect(rt.speedKmh).toBe(0);
    expect(rt.progress).toBe(0);
    expect(rt.grid).toEqual({ x: 3, z: 0 });
    expect(rt.prevGrid).toBeNull();
    expect(rt.stopRemaining).toBe(0);
    expect(rt.pendingDepartureFrom).toBeNull();
  });

  it('置き直すと元の位置の予約が解放され、新しい位置が予約される', () => {
    const world = setup();
    relocateTrain(world, 't1', { x: 3, z: 0 });

    expect(world.reservations!.get(reservationKey({ x: 0, z: 0 }))).toBeUndefined();
    expect(world.reservations!.get(reservationKey({ x: -1, z: 0 }))).toBeUndefined();
    expect(world.reservations!.get(reservationKey({ x: 1, z: 0 }))).toBeUndefined();
    expect(world.reservations!.get(reservationKey({ x: 3, z: 0 }))).toBe('t1');
    expect(world.reservations!.get(reservationKey({ x: 4, z: 0 }))).toBe('t1');
  });

  it('失敗したときはworldが変化しない', () => {
    const world = setup();
    const before = JSON.stringify({
      rt: world.runtimes.get('t1'),
      reservations: Array.from(world.reservations!.entries()),
    });

    const ok = relocateTrain(world, 't1', { x: 9, z: 9 }); // 線路の無いセル
    expect(ok).toBe(false);

    const after = JSON.stringify({
      rt: world.runtimes.get('t1'),
      reservations: Array.from(world.reservations!.entries()),
    });
    expect(after).toBe(before);
  });

  it('置き直した列車が、その後のstepWorldで実際に経路を再検索して走り出す(統合テスト)', () => {
    // 0-1-2-3-4-5-6-7 の直線に駅stAを末端(7)に置く。
    const cells = Array.from({ length: 8 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    railMap.set(toKey(7, 0), { ...railMap.get(toKey(7, 0))!, type: 'station', stationId: 'stA' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 7, z: 0 }, { x: 7, z: 1 }], center: { x: 7, z: 0 }, platformDoors: 'none' }],
    ]);
    const train = makeTrain({ id: 't1', x: 0, z: 0, cars: 2, schedule: ['stA'], status: 'running' });
    const world = makeWorld(railMap, stations, [train]);

    // まずデッドロック的な「経路の見つからない」状態を再現する: セル0に列車を置き、
    // route空のままrelocateTrainでセル2へ動かす(セル1側が塞がっている想定の代わり)。
    stepWorld(world, 0.1); // ensureRuntimeが呼ばれてrtが作られる
    const ok = relocateTrain(world, 't1', { x: 2, z: 0 });
    expect(ok).toBe(true);

    // 以降のtickで経路が再検索され、駅へ向けて走り出すはず。
    let moved = false;
    for (let i = 0; i < 200; i++) {
      stepWorld(world, 0.1);
      const rt = world.runtimes.get('t1')!;
      if (rt.speedKmh > 0) {
        moved = true;
        break;
      }
    }
    expect(moved).toBe(true);
  });
});
