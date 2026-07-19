import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld, SimEvent } from './simulation';

// 車庫(0,0)の真ん前に駅X(1,0)、その先に駅Y(5,0)がある直線区間。
// 「車庫の真ん前に駅があるとバグるかもしれない」という報告の再現・修正確認用シナリオ。
const buildDepotLine = () => {
  const cells = Array.from({ length: 6 }, (_, i) => ({ x: i, z: 0 })); // 0..5
  const railMap = new Map<string, CellData>();
  for (let i = 0; i < cells.length - 1; i++) {
    const curr = cells[i];
    const next = cells[i + 1];
    const dir = getDirFromVector(next.x - curr.x, next.z - curr.z);
    const oppDir = getOppositeDir(dir);
    const currKey = toKey(curr.x, curr.z);
    const currCell = railMap.get(currKey) || { type: 'rail' as const, connections: 0 };
    railMap.set(currKey, { ...currCell, connections: (currCell.connections || 0) | dir });
    const nextKey = toKey(next.x, next.z);
    const nextCell = railMap.get(nextKey) || { type: 'rail' as const, connections: 0 };
    railMap.set(nextKey, { ...nextCell, connections: (nextCell.connections || 0) | oppDir });
  }
  railMap.set(toKey(0, 0), { ...railMap.get(toKey(0, 0))!, type: 'depot', rotation: 0 });
  railMap.set(toKey(1, 0), { ...railMap.get(toKey(1, 0))!, type: 'station', stationId: 'stX' });
  railMap.set(toKey(5, 0), { ...railMap.get(toKey(5, 0))!, type: 'station', stationId: 'stY' });

  const stations = new Map<string, StationData>([
    ['stX', { id: 'stX', name: 'X', cells: [{ x: 1, z: 0 }], center: { x: 1, z: 0 }, platformDoors: 'none' }],
    ['stY', { id: 'stY', name: 'Y', cells: [{ x: 5, z: 0 }], center: { x: 5, z: 0 }, platformDoors: 'none' }],
  ]);
  return { railMap, stations };
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

const makeWorld = (railMap: Map<string, CellData>, stations: Map<string, StationData>, trains: TrainData[]): SimWorld => ({
  railMap, stations, trains, runtimes: new Map(), waiting: new Map(), rng: () => 1,
});

// 実機のuseGameLogic.handleTrainArrive相当。arriveイベントでscheduleIndexを進める。
const advanceSchedule = (train: TrainData, events: SimEvent[]) => {
  events.forEach(e => {
    if (e.type === 'arrive' && e.trainId === train.id) {
      train.scheduleIndex = (train.scheduleIndex + 1) % train.schedule.length;
    }
  });
};

const runTicks = (world: SimWorld, train: TrainData, dt: number, count: number): SimEvent[] => {
  const all: SimEvent[] = [];
  for (let i = 0; i < count; i++) {
    const evs = stepWorld(world, dt);
    all.push(...evs);
    advanceSchedule(train, evs);
  }
  return all;
};

describe('車庫の真ん前に駅があるシナリオ', () => {
  it('シナリオ1: スケジュール[X, Y] で X に到着・停車後、Y へ発車できる', () => {
    const { railMap, stations } = buildDepotLine();
    const train = makeTrain({ schedule: ['stX', 'stY'] });
    const world = makeWorld(railMap, stations, [train]);

    const events = runTicks(world, train, 0.1, 200);
    const rt = world.runtimes.get('t1')!;

    expect(events.some(e => e.type === 'arrive' && (e as any).scheduleIndex === 0)).toBe(true);
    expect(rt.debugStatus).not.toBe('Waiting for Path...');
    // stYに到着していること(cars=2でホーム長1のため多少停車時間が延びるが十分なtick数)
    expect(rt.grid.x).toBe(5);
  });

  it('シナリオ2: スケジュール[Y, X](先に遠い駅へ)でも正常に往復できる', () => {
    const { railMap, stations } = buildDepotLine();
    const train = makeTrain({ schedule: ['stY', 'stX'] });
    const world = makeWorld(railMap, stations, [train]);

    const events = runTicks(world, train, 0.1, 400);
    const rt = world.runtimes.get('t1')!;

    expect(events.some(e => e.type === 'arrive')).toBe(true);
    expect(rt.debugStatus).not.toBe('Waiting for Path...');
  });

  it('シナリオ3: 4両編成(trailが車庫からはみ出す)でも正常に発車・停車する', () => {
    const { railMap, stations } = buildDepotLine();
    const train = makeTrain({ schedule: ['stX', 'stY'], cars: 4 });
    const world = makeWorld(railMap, stations, [train]);

    // stYで停車した瞬間(stopRemaining>0)を捉える。スケジュールは[stX,stY]の巡回なので、
    // 固定tick数だけ回すと停車完了後にすぐ折り返し発車してしまい、位置検証が不安定になるため
    // 「停車した瞬間」で打ち切る。
    const events: SimEvent[] = [];
    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 300; i++) {
      const evs = stepWorld(world, 0.1);
      events.push(...evs);
      advanceSchedule(train, evs);
      rt = world.runtimes.get('t1')!;
      if (rt.grid.x === 5 && rt.stopRemaining > 0) break;
    }

    expect(events.some(e => e.type === 'arrive')).toBe(true);
    expect(rt!.debugStatus).not.toBe('Waiting for Path...');
    expect(rt!.grid.x).toBe(5);
  });

  it('シナリオ4: スケジュールが[X]のみ(単独駅)ではarriveはちょうど1回だけ発行され、その後は静かに待機し続ける', () => {
    const { railMap, stations } = buildDepotLine();
    const train = makeTrain({ schedule: ['stX'] });
    const world = makeWorld(railMap, stations, [train]);

    // 最初にstXへ到着するまで進める(編成中央基準でホームの1つ先(x=2)まで走るぶん
    // 従来より距離が伸びるため、十分なtick数を確保する)
    let events = runTicks(world, train, 0.1, 150);
    const firstArrivals = events.filter(e => e.type === 'arrive');
    expect(firstArrivals.length).toBe(1);
    let rt = world.runtimes.get('t1')!;
    // 編成中央基準の停止位置: stXはP=1セル、cars=2 -> headIdx=ceil((1+2)/2)-1=1。
    // ホームセル(x=1)の1つ先(x=2)まで延長して停車する。
    expect(rt.grid.x).toBe(2);

    // scheduleIndexは0のままstXに戻ってくる(単独駅スケジュールの仕様)。
    // この状態でさらに進めても、直前に停車を終えた駅と目的駅が同じ場合は
    // 再停車もarriveも発行せず、'At destination'で静かに待機し続けるのが仕様。
    // (以前はここでstopRemainingが再セットされ、arriveが繰り返し発火して
    //  発車不能になる回帰バグがあった)
    const evsAfter = runTicks(world, train, 0.1, 200);
    const arriveEventsAfter = evsAfter.filter(e => e.type === 'arrive');
    expect(arriveEventsAfter.length).toBe(0);
    rt = world.runtimes.get('t1')!;
    expect(rt.debugStatus).not.toBe('Waiting for Path...');
    expect(rt.debugStatus).toBe('At destination');
    expect(rt.stopRemaining).toBe(0);
    expect(rt.grid.x).toBe(2);
  });

  it('シナリオ5: スケジュール[A,B]でAの停車終了後、scheduleIndexが進む前に数tick進めてもAに再停車しない', () => {
    const { railMap, stations } = buildDepotLine();
    const train = makeTrain({ schedule: ['stX', 'stY'] });
    const world = makeWorld(railMap, stations, [train]);

    // stXに到着・停車完了(arriveイベント発行)まで進める。ただしscheduleIndexは
    // React側の非同期更新を模して、ここでは意図的にまだ進めない。
    let arrived = false;
    for (let i = 0; i < 200 && !arrived; i++) {
      const evs = stepWorld(world, 0.1);
      if (evs.some(e => e.type === 'arrive')) arrived = true;
    }
    expect(arrived).toBe(true);
    let rt = world.runtimes.get('t1')!;
    // 編成中央基準の停止位置: stXはP=1セル、cars=2 -> headIdx=1(ホームの1つ先=x=2)
    expect(rt.grid.x).toBe(2);
    expect(rt.lastStopStationId).toBe('stX');
    expect(train.scheduleIndex).toBe(0); // まだ進めていない

    // scheduleIndexを進めずに数tick進めても、stXに再停車しない(stopRemainingは0のまま)
    for (let i = 0; i < 20; i++) {
      stepWorld(world, 0.1);
    }
    rt = world.runtimes.get('t1')!;
    expect(rt.stopRemaining).toBe(0);
    expect(rt.grid.x).toBe(2);
    expect(rt.debugStatus).toBe('At destination');

    // scheduleIndexをBへ進めれば、通常の経路探索で発車してYへ到着する。
    // schedule=[stX,stY]は巡回するため、固定tick数で打ち切ると停車完了(arriveイベント)後に
    // すぐ折り返し発車してしまい得るので、arriveイベントが発行された時点(まだYで停車中)で打ち切る。
    train.scheduleIndex = 1;
    const events: SimEvent[] = [];
    for (let i = 0; i < 150; i++) {
      const evs = stepWorld(world, 0.1);
      events.push(...evs);
      advanceSchedule(train, evs);
      rt = world.runtimes.get('t1')!;
      if (evs.some(e => e.type === 'arrive')) break;
    }
    expect(events.some(e => e.type === 'arrive')).toBe(true);
    expect(rt.grid.x).toBe(5);
  });
});
