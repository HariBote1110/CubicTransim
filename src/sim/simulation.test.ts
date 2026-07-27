import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData, TownData } from '../types';
import { stepWorld, STOP_DURATION, DECEL_KMH_S, MAX_SPEED_KMH } from './simulation';
import type { SimWorld, SimEvent } from './simulation';
import { carPositions } from './consist';
import { computeAcceleration, TRAIN_SPECS, DEFAULT_TRAIN_TYPE } from './physics';
import {
  PASSENGER_SPAWN_RATE,
  STATION_WAITING_CAP,
  CAPACITY_PER_CAR,
  FARE_PER_TILE,
  ACCIDENT_HALT_DURATION,
  ACCIDENT_PENALTY,
  demandFactor,
  SECONDS_PER_DAY,
  DAYS_PER_MONTH,
} from './economy';

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

const TRAIN_CAPACITY = 2 * CAPACITY_PER_CAR;

// 待ち客を「行き先つき」で仕込む。旅客は行き先を持つようになったため、
// world.waitingに直接数字を入れても列車には乗らない(乗る先が分からないため)。
const seedWaiting = (world: SimWorld, stationId: string, destinationId: string, count: number) => {
  if (!world.demand) world.demand = new Map();
  const cohorts = world.demand.get(stationId) ?? [];
  cohorts.push({ destinationId, count });
  world.demand.set(stationId, cohorts);
  world.waiting.set(stationId, (world.waiting.get(stationId) ?? 0) + count);
};

// rng省略時は常に1を返す(=事故が発生しない)ことで既存テストの決定性を保つ。
// towns省略時は空(=旅客需要が発生しない、旧仕様のテストとの互換用)。
const makeWorld = (
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  trains: TrainData[],
  rng: () => number = () => 1,
  towns: TownData[] = []
): SimWorld => ({
  railMap, stations, trains, runtimes: new Map(), waiting: new Map(), rng, towns,
});

// 各駅の真上(distance=0)にpopulation=1000の街を置き、demandFactor=1として
// 従来のPASSENGER_SPAWN_RATE固定の旅客需要テストと同じ挙動を再現するためのヘルパー。
const townsAtStations = (stations: StationData[]): TownData[] =>
  stations.map(st => ({ id: `town-${st.id}`, centre: { ...st.center }, population: 1000 }));

// 直線上に2駅(両端)を置く。列車が往復してincome/lastStopStationIdを検証するために使う。
// railMap上の駅セルは1つのまま(経路探索・到着挙動を既存テストと同一に保つ)。
// StationData.cellsだけ2セル分のダミー座標にして、既定のcars=2とホーム長が一致し、
// ホーム長ペナルティが既存テストの数値に影響しないようにする。
const buildTwoStationLine = (length: number, stationAId: string, stationBId: string) => {
  const cells = Array.from({ length }, (_, i) => ({ x: i, z: 0 }));
  const railMap = buildRailMap(cells);
  const aKey = toKey(0, 0);
  const bKey = toKey(length - 1, 0);
  railMap.set(aKey, { ...railMap.get(aKey)!, type: 'station', stationId: stationAId });
  railMap.set(bKey, { ...railMap.get(bKey)!, type: 'station', stationId: stationBId });
  const stations = new Map<string, StationData>([
    [stationAId, { id: stationAId, name: 'A', cells: [{ x: 0, z: 0 }, { x: 0, z: 1 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
    [stationBId, { id: stationBId, name: 'B', cells: [{ x: length - 1, z: 0 }, { x: length - 1, z: 1 }], center: { x: length - 1, z: 0 }, platformDoors: 'none' }],
  ]);
  return { railMap, stations };
};

const runUntilStopped = (world: SimWorld, dt: number, maxTicks: number): SimEvent[] => {
  const events: SimEvent[] = [];
  for (let i = 0; i < maxTicks; i++) {
    events.push(...stepWorld(world, dt));
    const rt = world.runtimes.get(world.trains[0].id);
    if (rt && rt.stopRemaining > 0) break;
  }
  return events;
};

const runTicks = (world: SimWorld, dt: number, count: number): SimEvent[] => {
  const events: SimEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push(...stepWorld(world, dt));
  }
  return events;
};

// railMap上の駅セルは常に1つ(経路探索・到着挙動を既存テストと同一に保つ)。
// StationData.cellsだけplatformLen個のダミー座標にする(ホーム長ペナルティ計算はcells.lengthのみを見るため)。
// 既定値2は既定のcars=2と一致し、ホーム長ペナルティが既存テストの数値に影響しないようにする。
const buildStraightLine = (length: number, stationId: string, platformLen = 2) => {
  const cells = Array.from({ length }, (_, i) => ({ x: i, z: 0 }));
  const railMap = buildRailMap(cells);
  const lastKey = toKey(length - 1, 0);
  railMap.set(lastKey, { ...railMap.get(lastKey)!, type: 'station', stationId });
  const platformCells = Array.from({ length: platformLen }, (_, i) => ({ x: length - 1, z: i }));
  const stations = new Map<string, StationData>([
    [stationId, { id: stationId, name: 'A', cells: platformCells, center: { x: length - 1, z: 0 }, platformDoors: 'none' }],
  ]);
  return { railMap, stations };
};

describe('stepWorld', () => {
  it('加速: 障害物が無ければ物理加速モデル(F/m)で速度が増える', () => {
    const { railMap, stations } = buildStraightLine(10, 'stA');
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train]);

    const dt = 0.1;
    runTicks(world, dt, 3);

    const rt = world.runtimes.get('t1')!;
    // 発進直後(低速域)は牽引力(粘着限界)がほぼ一定なため、加速度もほぼ一定になる。
    const accelMs2 = computeAcceleration(
      { spec: TRAIN_SPECS[DEFAULT_TRAIN_TYPE], cars: train.cars, passengers: 0, speedKmh: 0 },
      'accelerating',
      DECEL_KMH_S
    );
    expect(rt.speedKmh).toBeCloseTo(accelMs2 * 3.6 * dt * 3, 3);
  });

  it('加速: 満載時は空車より加速が鈍り、同じ時間での到達速度が低くなる', () => {
    const trainCapacity = TRAIN_CAPACITY;
    const dt = 0.1;

    const emptyLine = buildStraightLine(30, 'stEmpty');
    const emptyTrain = makeTrain({ id: 'tEmpty', schedule: ['stEmpty'] });
    const emptyWorld = makeWorld(emptyLine.railMap, emptyLine.stations, [emptyTrain]);
    runTicks(emptyWorld, dt, 20);
    const emptyRt = emptyWorld.runtimes.get('tEmpty')!;

    const fullLine = buildStraightLine(30, 'stFull');
    const fullTrain = makeTrain({ id: 'tFull', schedule: ['stFull'] });
    const fullWorld = makeWorld(fullLine.railMap, fullLine.stations, [fullTrain]);
    // ランタイムだけ先に作らせ(1tick目はdt=0で進行に影響させない)、満載状態を直接注入する
    // (乗降処理を経由せず、質量差の影響だけを見るため)。
    runTicks(fullWorld, 0, 1);
    fullWorld.runtimes.get('tFull')!.passengers = trainCapacity;
    runTicks(fullWorld, dt, 20);
    const fullRt = fullWorld.runtimes.get('tFull')!;

    expect(fullRt.speedKmh).toBeLessThan(emptyRt.speedKmh);
  });

  it('走行: progressが進みマスが進行してtrailが更新される(上限=train.cars)', () => {
    const { railMap, stations } = buildStraightLine(10, 'stA');
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train]);

    const dt = 0.1;
    let ticks = 0;
    let rt = world.runtimes.get('t1');
    while (ticks < 3000) {
      stepWorld(world, dt);
      ticks++;
      rt = world.runtimes.get('t1')!;
      if (rt.grid.x >= 2) break;
    }

    expect(rt!.grid.x).toBeGreaterThanOrEqual(2);
    expect(rt!.trail.length).toBe(train.cars);
    expect(rt!.trail[0]).toEqual(rt!.grid);
  });

  it('目標駅到着: 停車しstopRemaining=STOP_DURATIONがセットされ、speed=0になる', () => {
    const { railMap, stations } = buildStraightLine(6, 'stA');
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train]);

    const dt = 0.1;
    let ticks = 0;
    let rt = world.runtimes.get('t1');
    while (ticks < 5000) {
      stepWorld(world, dt);
      ticks++;
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }

    expect(rt!.stopRemaining).toBe(STOP_DURATION);
    expect(rt!.speedKmh).toBe(0);
    expect(rt!.grid).toEqual({ x: 5, z: 0 });
  });

  it('3秒経過(dtを複数回)でarriveイベントが1回だけ発行される', () => {
    const { railMap, stations } = buildStraightLine(6, 'stA');
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train]);

    const dt = 0.1;
    let ticks = 0;
    let rt = world.runtimes.get('t1');
    while (ticks < 5000) {
      stepWorld(world, dt);
      ticks++;
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }

    let arriveCount = 0;
    for (let i = 0; i < 10; i++) {
      const evs = stepWorld(world, 0.5);
      arriveCount += evs.filter(e => e.type === 'arrive').length;
    }

    expect(arriveCount).toBe(1);
  });

  it('前方マスを他列車のtrailが占有していれば速度0になる(即時ブロック)', () => {
    const { railMap, stations } = buildStraightLine(5, 'stA');
    const trainA = makeTrain({ id: 'A', schedule: ['stA'] });
    const trainB = makeTrain({ id: 'B', x: 1, z: 0, status: 'stored' });
    const world = makeWorld(railMap, stations, [trainA, trainB]);

    world.runtimes.set('B', {
      id: 'B', grid: { x: 1, z: 0 }, prevGrid: null, progress: 0, speedKmh: 0,
      route: [], trail: [{ x: 1, z: 0 }], pathHistory: [{ x: 1, z: 0 }], stopRemaining: 0, waitTimer: 0, debugStatus: '',
      renderPos: { x: 1, y: 0.5, z: 0 }, renderTarget: null,
      passengers: 0, lastStopStationId: null, haltRemaining: 0, reservedEndIndex: -1,
    });

    stepWorld(world, 0.1);

    const rtA = world.runtimes.get('A')!;
    expect(rtA.speedKmh).toBe(0);
  });

  it('storedの列車はrouteもspeedも変化しない(runtimeも生成しない)', () => {
    const { railMap, stations } = buildStraightLine(5, 'stA');
    const train = makeTrain({ schedule: ['stA'], status: 'stored' });
    const world = makeWorld(railMap, stations, [train]);

    runTicks(world, 0.1, 10);

    expect(world.runtimes.get('t1')).toBeUndefined();
  });
});

describe('stepWorld: 立地需要(街との距離)', () => {
  it('街が近い駅は waiting が増え、街が無い/遠い駅は増えない', () => {
    // stA(x=0)の真上に街を置き、stB(x=19、影響半径10の外)には街の影響が届かない
    const { railMap, stations } = buildTwoStationLine(20, 'stA', 'stB');
    const towns: TownData[] = [{ id: 'town-near', centre: { x: 0, z: 0 }, population: 2000 }];
    const world = makeWorld(railMap, stations, [], () => 1, towns);

    stepWorld(world, 1.0);

    expect(world.waiting.get('stA')).toBeGreaterThan(0);
    expect(world.waiting.get('stB')).toBe(0);
  });

  it('街が全く無ければどの駅も waiting は増えない', () => {
    const { railMap, stations } = buildTwoStationLine(6, 'stA', 'stB');
    const world = makeWorld(railMap, stations, [], () => 1, []);

    stepWorld(world, 10.0);

    expect(world.waiting.get('stA')).toBe(0);
    expect(world.waiting.get('stB')).toBe(0);
  });
});

describe('stepWorld: 旅客需要と運賃収入', () => {
  it('waitingは毎tick PASSENGER_SPAWN_RATE×demandFactor×dt ずつ増え、STATION_WAITING_CAPで頭打ちになる', () => {
    const { railMap, stations } = buildTwoStationLine(6, 'stA', 'stB');
    const towns = townsAtStations(Array.from(stations.values()));
    const world = makeWorld(railMap, stations, [], () => 1, towns);
    const factorA = demandFactor(stations.get('stA')!.center, towns);
    const factorB = demandFactor(stations.get('stB')!.center, towns);

    stepWorld(world, 1.0);
    expect(world.waiting.get('stA')).toBeCloseTo(PASSENGER_SPAWN_RATE * factorA, 5);
    expect(world.waiting.get('stB')).toBeCloseTo(PASSENGER_SPAWN_RATE * factorB, 5);

    // 大きなdtで一気に上限を超えさせる
    stepWorld(world, 100000);
    expect(world.waiting.get('stA')).toBe(STATION_WAITING_CAP);
  });

  it('停車時にwaitingから最大TRAIN_CAPACITYまで乗車し、waitingが減る', () => {
    const { railMap, stations } = buildTwoStationLine(6, 'stA', 'stB');
    const towns = townsAtStations(Array.from(stations.values()));
    const train = makeTrain({ schedule: ['stB', 'stA'] });
    const world = makeWorld(railMap, stations, [train], () => 1, towns);
    const factorB = demandFactor(stations.get('stB')!.center, towns);
    // stBに大量の待ち客がいる状態を用意(capacityを超える)
    seedWaiting(world, 'stB', 'stA', TRAIN_CAPACITY + 50);

    // 停車する直前(dt適用前)のwaiting値を都度記録し、境界の1tickでの
    // 需要増加分を厳密に織り込んで期待値を計算する
    let waitingJustBeforeStop = world.waiting.get('stB')!;
    for (let i = 0; i < 5000; i++) {
      waitingJustBeforeStop = world.waiting.get('stB') ?? 0;
      stepWorld(world, 0.1);
      const rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }

    const rt = world.runtimes.get('t1')!;
    expect(rt.passengers).toBe(TRAIN_CAPACITY);
    const waitingAfterGrowth = Math.min(STATION_WAITING_CAP, waitingJustBeforeStop + PASSENGER_SPAWN_RATE * factorB * 0.1);
    expect(world.waiting.get('stB')).toBeCloseTo(waitingAfterGrowth - TRAIN_CAPACITY, 5);
  });

  it('停車直後もrenderTargetが進入方向の延長線上を指し、列車の向きが維持される', () => {
    const { railMap, stations } = buildTwoStationLine(6, 'stA', 'stB');
    const towns = townsAtStations(Array.from(stations.values()));
    const train = makeTrain({ x: 0, z: 0, schedule: ['stB', 'stA'] });
    const world = makeWorld(railMap, stations, [train], () => 1, towns);

    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 5000; i++) {
      stepWorld(world, 0.1);
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }

    rt = world.runtimes.get('t1')!;
    expect(rt.stopRemaining).toBeGreaterThan(0);
    expect(rt.renderTarget).not.toBeNull();
    // このレーンは常にx+方向(東)へ進むので、進入方向の延長線上=停止セルよりxが大きい点になる
    expect(rt.renderTarget!.x).toBeGreaterThan(rt.grid.x);
    expect(rt.renderTarget!.z).toBeCloseTo(rt.grid.z, 5);
  });

  it('waitingが小数(38.7人)のとき乗車は38人の整数になり、端数0.7人は駅に残る', () => {
    const { railMap, stations } = buildTwoStationLine(6, 'stA', 'stB');
    const towns = townsAtStations(Array.from(stations.values()));
    const train = makeTrain({ schedule: ['stB', 'stA'] });
    const world = makeWorld(railMap, stations, [train], () => 1, towns);
    // stepWorldの旅客需要増加(demandFactor依存)による誤差を避けるため、townsを空にして
    // waitingが停車直前まで固定値のまま変化しないようにする
    world.towns = [];
    seedWaiting(world, 'stB', 'stA', 38.7);

    for (let i = 0; i < 5000; i++) {
      stepWorld(world, 0.1);
      const rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }

    const rt = world.runtimes.get('t1')!;
    expect(rt.passengers).toBe(38);
    expect(Number.isInteger(rt.passengers)).toBe(true);
    expect(world.waiting.get('stB')).toBeCloseTo(0.7, 5);
  });

  it('2駅目到着時にincomeイベントが発行される(金額=距離×FARE_PER_TILE×人数)', () => {
    const length = 6;
    const { railMap, stations } = buildTwoStationLine(length, 'stA', 'stB');
    // 列車はどちらの駅上にも置かず、中間セルから出発させる
    // (駅上から出発すると同一駅への経路長0でrouteが見つからず、到着イベントが発生しない)
    const towns = townsAtStations(Array.from(stations.values()));
    const train = makeTrain({ x: Math.floor(length / 2), z: 0, schedule: ['stA', 'stB'] });
    const world = makeWorld(railMap, stations, [train], () => 1, towns);
    seedWaiting(world, 'stA', 'stB', 10);

    // 1駅目(stA)到着: 乗車のみ、income無し
    // (移動中もwaitingは増え続けるため、実際に乗車した人数を記録して以降の期待値に使う)
    const eventsAtA = runUntilStopped(world, 0.1, 5000);
    expect(eventsAtA.some(e => e.type === 'income')).toBe(false);
    const rtAfterA = world.runtimes.get('t1')!;
    const boardedAtA = rtAfterA.passengers;
    expect(boardedAtA).toBeGreaterThanOrEqual(10);
    expect(rtAfterA.lastStopStationId).toBe('stA');

    // 停車完了(STOP_DURATION経過)でarriveイベントが発行されるので、
    // 実機のuseGameLogic.handleTrainArrive相当の処理でscheduleIndexを進める
    let events: SimEvent[] = [];
    for (let i = 0; i < 50; i++) {
      const evs = stepWorld(world, 0.1);
      events.push(...evs);
      evs.forEach(e => {
        if (e.type === 'arrive') train.scheduleIndex = (train.scheduleIndex + 1) % train.schedule.length;
      });
    }
    // 2駅目(stB)到着まで進める
    let ticks = 0;
    let rt = world.runtimes.get('t1')!;
    while (ticks < 5000 && rt.grid.x !== length - 1) {
      events.push(...stepWorld(world, 0.1));
      rt = world.runtimes.get('t1')!;
      ticks++;
    }

    const incomeEvents = events.filter(e => e.type === 'income');
    expect(incomeEvents.length).toBe(1);
    const incomeEvent = incomeEvents[0] as Extract<SimEvent, { type: 'income' }>;
    expect(incomeEvent.passengers).toBe(boardedAtA);
    expect(incomeEvent.amount).toBeCloseTo((length - 1) * FARE_PER_TILE * boardedAtA, 5);
    expect(rt.lastStopStationId).toBe('stB');
  });
});

describe('stepWorld: 人身事故とホームドア', () => {
  const buildStraightLineWithDoors = (length: number, stationId: string, doors: StationData['platformDoors']) => {
    const { railMap, stations } = buildStraightLine(length, stationId);
    stations.set(stationId, { ...stations.get(stationId)!, platformDoors: doors });
    return { railMap, stations };
  };

  it('rng=0(必ず発生): 停車時にaccidentイベントが発行されhaltRemaining=60になり、halt中は動かず、halt終了後に通常停車→発車する', () => {
    const { railMap, stations } = buildStraightLineWithDoors(6, 'stA', 'none');
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train], () => 0);

    const events = runUntilStopped(world, 0.1, 5000);
    const rt = world.runtimes.get('t1')!;

    const accidentEvents = events.filter(e => e.type === 'accident');
    expect(accidentEvents.length).toBe(1);
    const accidentEvent = accidentEvents[0] as Extract<SimEvent, { type: 'accident' }>;
    expect(accidentEvent.stationId).toBe('stA');
    expect(accidentEvent.penalty).toBe(ACCIDENT_PENALTY);
    expect(rt.haltRemaining).toBe(ACCIDENT_HALT_DURATION);

    // halt中は完全停止し続ける
    stepWorld(world, 10);
    expect(rt.haltRemaining).toBeCloseTo(ACCIDENT_HALT_DURATION - 10, 5);
    expect(rt.speedKmh).toBe(0);
    expect(rt.debugStatus).toBe('Service suspended (accident)');
    expect(rt.stopRemaining).toBe(STOP_DURATION);

    // halt完了まで進める
    stepWorld(world, ACCIDENT_HALT_DURATION - 10);
    expect(rt.haltRemaining).toBe(0);

    // haltが尽きたら通常のstopRemaining消化に入る
    stepWorld(world, STOP_DURATION);
    expect(rt.stopRemaining).toBe(0);
  });

  it('rng=0.999: 事故イベントは発行されない', () => {
    const { railMap, stations } = buildStraightLineWithDoors(6, 'stA', 'none');
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train], () => 0.999);

    const events = runUntilStopped(world, 0.1, 5000);
    const rt = world.runtimes.get('t1')!;

    expect(events.some(e => e.type === 'accident')).toBe(false);
    expect(rt.haltRemaining).toBe(0);
  });

  it('standardドア: 確率が0.05倍になる(混雑度によらない上限0.05*1.5*BASEを超えるrngでは発生しない)', () => {
    // standardの確率は 0.05 * (0.5〜1.5) * ACCIDENT_BASE_CHANCE = 0.00025〜0.00075 の範囲に収まる。
    // 下限より小さいrngなら混雑度に関わらず必ず発生し、上限より大きいrngなら絶対に発生しない。
    const belowMin = 0.0002; // < 0.00025
    const aboveMax = 0.0008; // > 0.00075

    const { railMap: railMap1, stations: stations1 } = buildStraightLineWithDoors(6, 'stA', 'standard');
    const train1 = makeTrain({ schedule: ['stA'] });
    const world1 = makeWorld(railMap1, stations1, [train1], () => belowMin);
    runUntilStopped(world1, 0.1, 5000);
    expect(world1.runtimes.get('t1')!.haltRemaining).toBeGreaterThan(0);

    const { railMap: railMap2, stations: stations2 } = buildStraightLineWithDoors(6, 'stA', 'standard');
    const train2 = makeTrain({ schedule: ['stA'] });
    const world2 = makeWorld(railMap2, stations2, [train2], () => aboveMax);
    runUntilStopped(world2, 0.1, 5000);
    expect(world2.runtimes.get('t1')!.haltRemaining).toBe(0);
  });

  it('fullscreenドア: rng=0でも事故は発生しない', () => {
    const { railMap, stations } = buildStraightLineWithDoors(6, 'stA', 'fullscreen');
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train], () => 0);

    const events = runUntilStopped(world, 0.1, 5000);
    const rt = world.runtimes.get('t1')!;

    expect(events.some(e => e.type === 'accident')).toBe(false);
    expect(rt.haltRemaining).toBe(0);
  });
});

describe('stepWorld: 編成(consist)システム', () => {
  it('定員はcars×CAPACITY_PER_CARになる(cars=1と8の境界)', () => {
    const capacityFor = (cars: number) => {
      const { railMap, stations } = buildTwoStationLine(6, 'stA', 'stB');
      const towns = townsAtStations(Array.from(stations.values()));
      const train = makeTrain({ schedule: ['stB', 'stA'], cars });
      const world = makeWorld(railMap, stations, [train], () => 1, towns);
      seedWaiting(world, 'stB', 'stA', 9999);
      for (let i = 0; i < 5000; i++) {
        stepWorld(world, 0.1);
        const rt = world.runtimes.get('t1')!;
        if (rt.stopRemaining > 0) break;
      }
      return world.runtimes.get('t1')!.passengers;
    };

    // cars=1(定員50)はSTATION_WAITING_CAP(200)未満なのでそのまま定員まで乗車する。
    expect(capacityFor(1)).toBe(1 * CAPACITY_PER_CAR);
    // cars=8(定員400)はSTATION_WAITING_CAP(200)を超えるため、実際の乗車数は
    // 駅の待ち上限に頭打ちされる(定員の計算式自体はcars×CAPACITY_PER_CARで正しく効いている)。
    expect(capacityFor(8)).toBe(Math.min(8 * CAPACITY_PER_CAR, STATION_WAITING_CAP));
  });

  it('trailの物理長上限はtrain.carsに一致する(cars=1と8の境界)', () => {
    const trailLenFor = (cars: number) => {
      const { railMap, stations } = buildStraightLine(20, 'stA');
      const train = makeTrain({ schedule: ['stA'], cars });
      const world = makeWorld(railMap, stations, [train]);
      let rt = world.runtimes.get('t1');
      for (let i = 0; i < 3000; i++) {
        stepWorld(world, 0.1);
        rt = world.runtimes.get('t1')!;
        if (rt.grid.x >= cars + 1) break;
      }
      return rt!.trail.length;
    };

    expect(trailLenFor(1)).toBe(1);
    expect(trailLenFor(8)).toBe(8);
  });

  it('ホーム長ペナルティ: 3両編成が2セル駅に停車するとstopRemaining=STOP_DURATION×1.5になる', () => {
    const { railMap, stations } = buildStraightLine(8, 'stA', 2);
    const train = makeTrain({ schedule: ['stA'], cars: 3 });
    const world = makeWorld(railMap, stations, [train]);

    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 5000; i++) {
      stepWorld(world, 0.1);
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }

    expect(rt!.stopRemaining).toBeCloseTo(STOP_DURATION * 1.5, 5);
  });

  it('ホーム長ペナルティ: 編成がホーム長以下なら通常のSTOP_DURATIONのまま', () => {
    const { railMap, stations } = buildStraightLine(8, 'stA', 2);
    const train = makeTrain({ schedule: ['stA'], cars: 2 });
    const world = makeWorld(railMap, stations, [train]);

    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 5000; i++) {
      stepWorld(world, 0.1);
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }

    expect(rt!.stopRemaining).toBeCloseTo(STOP_DURATION, 5);
  });
});

describe('stepWorld: 減速カーブ(距離ベースの許容速度)', () => {
  it('100km/hからの停止で、速度が10km/h未満である時間が過大にならない(OpenTTD流の駅接近クランプにより従来より長め)', () => {
    // OpenTTDノートB節の駅接近クランプ(st_max_speed=max(25×残りセル数, ...))を導入したことで、
    // 停止直前(残り1セル未満)は意図的に25km/h以下へゆっくり滑り込むようになり、
    // 以前(sqrt(2ad)カーブのみ)より低速区間が長くなる。この仕様変更を踏まえて上限を緩めた。
    const { railMap, stations } = buildStraightLine(250, 'stA', 2);
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train]);

    const dt = 0.05;
    let timeBelow10 = 0;
    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 20000; i++) {
      stepWorld(world, dt);
      rt = world.runtimes.get('t1')!;
      if (rt.speedKmh > 0 && rt.speedKmh < 10) timeBelow10 += dt;
      if (rt.stopRemaining > 0) break;
    }

    expect(rt!.speedKmh === 0 || rt!.stopRemaining > 0).toBe(true);
    expect(timeBelow10).toBeLessThanOrEqual(10);
  });

  it('MAX_SPEED_KMHを超えて加速しない(距離が十分あれば最高速度まで到達する)', () => {
    const { railMap, stations } = buildStraightLine(250, 'stA', 2);
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train]);

    const dt = 0.1;
    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 2000; i++) {
      stepWorld(world, dt);
      rt = world.runtimes.get('t1')!;
      expect(rt.speedKmh).toBeLessThanOrEqual(MAX_SPEED_KMH + 1e-6);
      if (rt.speedKmh >= MAX_SPEED_KMH - 0.01) break;
    }

    expect(rt!.speedKmh).toBeGreaterThanOrEqual(MAX_SPEED_KMH - 0.01);
  });
});

describe('stepWorld: 停車位置(ホーム全体基準)', () => {
  it('3セル連続ホームでは進行方向最後のホームセル(奥端)で停止する', () => {
    const cells = Array.from({ length: 8 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    for (const x of [5, 6, 7]) {
      railMap.set(toKey(x, 0), { ...railMap.get(toKey(x, 0))!, type: 'station', stationId: 'stP' });
    }
    const stations = new Map<string, StationData>([
      ['stP', { id: 'stP', name: 'P', cells: [{ x: 5, z: 0 }, { x: 6, z: 0 }, { x: 7, z: 0 }], center: { x: 6, z: 0 }, platformDoors: 'none' }],
    ]);
    const train = makeTrain({ schedule: ['stP'] });
    const world = makeWorld(railMap, stations, [train]);

    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 5000; i++) {
      stepWorld(world, 0.1);
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }

    expect(rt!.grid).toEqual({ x: 7, z: 0 });
  });
});

describe('stepWorld: 終端駅での瞬時反転', () => {
  it('終端駅到着後の発車時に編成が瞬時に反転し、車間一定を保って逆走し、A駅に到着する', () => {
    const length = 10;
    const { railMap, stations } = buildTwoStationLine(length, 'stA', 'stB');
    const train = makeTrain({ x: 0, z: 0, schedule: ['stB', 'stA'], cars: 4 });
    const world = makeWorld(railMap, stations, [train]);

    // stBに到着するまで進める
    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 5000; i++) {
      stepWorld(world, 0.1);
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }
    expect(rt!.grid).toEqual({ x: length - 1, z: 0 });

    // arriveイベントでscheduleIndexを進める(実機のhandleTrainArrive相当の処理)
    for (let i = 0; i < 100; i++) {
      const evs = stepWorld(world, 0.1);
      evs.forEach(e => {
        if (e.type === 'arrive') train.scheduleIndex = (train.scheduleIndex + 1) % train.schedule.length;
      });
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining === 0) break;
    }

    const oldTail = rt!.trail[rt!.trail.length - 1];

    // 発車(反転)する1tick
    stepWorld(world, 0.1);
    rt = world.runtimes.get('t1')!;

    // (a) 新先頭セルは旧最後尾セル
    expect(rt.grid).toEqual(oldTail);

    // (b) 発車直後の連続tickで車間(弧長基準)が常にspacing一定を保つ(めり込み・重なりなし)
    for (let i = 0; i < 150; i++) {
      stepWorld(world, 0.05);
      rt = world.runtimes.get('t1')!;
      const positions = carPositions(rt, 4, 1.0);
      for (let k = 1; k < positions.length; k++) {
        const dx = positions[k - 1].x - positions[k].x;
        const dz = positions[k - 1].z - positions[k].z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        expect(dist).toBeGreaterThan(0.9);
        expect(dist).toBeLessThan(1.1);
      }
    }

    // (c) その後A駅に到着する
    let arrivedAtA = false;
    for (let i = 0; i < 5000; i++) {
      stepWorld(world, 0.1);
      rt = world.runtimes.get('t1')!;
      if (rt.grid.x === 0 && rt.stopRemaining > 0) {
        arrivedAtA = true;
        break;
      }
    }
    expect(arrivedAtA).toBe(true);
  });
});

describe('stepWorld: ゲーム内暦とmonthEndイベント', () => {
  it('月を跨がないtickではmonthEndイベントは発行されない', () => {
    const world = makeWorld(new Map(), new Map(), []);
    const events = stepWorld(world, SECONDS_PER_DAY * DAYS_PER_MONTH - 1);
    expect(events.filter(e => e.type === 'monthEnd')).toHaveLength(0);
    expect(world.clock!.elapsed).toBeCloseTo(SECONDS_PER_DAY * DAYS_PER_MONTH - 1, 5);
  });

  it('ちょうど1ヶ月分のtickでmonthEndイベントが1回だけ発行される(終わった月=1月)', () => {
    const world = makeWorld(new Map(), new Map(), []);
    const events = stepWorld(world, SECONDS_PER_DAY * DAYS_PER_MONTH);
    const monthEnds = events.filter((e): e is Extract<SimEvent, { type: 'monthEnd' }> => e.type === 'monthEnd');
    expect(monthEnds).toHaveLength(1);
    expect(monthEnds[0]).toEqual({ type: 'monthEnd', year: 1, month: 1 });
  });

  it('複数月分の大きいdtでは月数分のmonthEndイベントが発行される', () => {
    const world = makeWorld(new Map(), new Map(), []);
    const events = stepWorld(world, SECONDS_PER_DAY * DAYS_PER_MONTH * 3);
    const monthEnds = events.filter((e): e is Extract<SimEvent, { type: 'monthEnd' }> => e.type === 'monthEnd');
    expect(monthEnds).toHaveLength(3);
    expect(monthEnds.map(e => e.month)).toEqual([1, 2, 3]);
  });

  it('2回目のtickで前回からの続きとして月跨ぎが検出される', () => {
    const world = makeWorld(new Map(), new Map(), []);
    stepWorld(world, SECONDS_PER_DAY * DAYS_PER_MONTH - 1);
    const events = stepWorld(world, 1);
    const monthEnds = events.filter(e => e.type === 'monthEnd');
    expect(monthEnds).toHaveLength(1);
  });
});

describe('stepWorld: 旅客の行き先と経路検索', () => {
  // 3駅を1本の線で結ぶ(stA --- stB --- stC)。
  const buildThreeStationLine = () => {
    const cells = Array.from({ length: 11 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    const stations = new Map<string, StationData>();
    const place = (id: string, x: number) => {
      railMap.set(toKey(x, 0), { ...railMap.get(toKey(x, 0))!, type: 'station', stationId: id });
      stations.set(id, { id, name: id, cells: [{ x, z: 0 }], center: { x, z: 0 }, platformDoors: 'none' });
    };
    place('stA', 0);
    place('stB', 5);
    place('stC', 10);
    return { railMap, stations };
  };

  it('列車が1本も走っていなければ、街が近くても待ち客は増えない', () => {
    const { railMap, stations } = buildThreeStationLine();
    const towns = townsAtStations(Array.from(stations.values()));
    const stored = makeTrain({ schedule: ['stA', 'stC'], status: 'stored' });
    const world = makeWorld(railMap, stations, [stored], () => 1, towns);

    stepWorld(world, 10);

    expect(world.waiting.get('stA') ?? 0).toBe(0);
    expect(world.waiting.get('stC') ?? 0).toBe(0);
  });

  it('列車が行かない駅は行き先にならない(その駅ゆきの客は湧かない)', () => {
    const { railMap, stations } = buildThreeStationLine();
    const towns = townsAtStations(Array.from(stations.values()));
    // stCには停まらない運行表
    const train = makeTrain({ schedule: ['stA', 'stB'] });
    const world = makeWorld(railMap, stations, [train], () => 1, towns);

    stepWorld(world, 10);

    const destinations = (world.demand?.get('stA') ?? []).map(c => c.destinationId);
    expect(destinations).toContain('stB');
    expect(destinations).not.toContain('stC');
  });

  it('旅客は途中駅では降りず、行き先の駅で降りて運賃収入になる', () => {
    const { railMap, stations } = buildThreeStationLine();
    const train = makeTrain({ x: 2, z: 0, schedule: ['stA', 'stB', 'stC'] });
    // 需要の自然増を止めて、仕込んだ客だけを追跡する
    const world = makeWorld(railMap, stations, [train], () => 1, []);
    seedWaiting(world, 'stA', 'stC', 10);

    const events: SimEvent[] = [];
    let arrivals = 0;
    for (let i = 0; i < 20000 && arrivals < 3; i++) {
      const evs = stepWorld(world, 0.1);
      events.push(...evs);
      evs.forEach(e => {
        if (e.type === 'arrive') {
          arrivals++;
          train.scheduleIndex = (train.scheduleIndex + 1) % train.schedule.length;
        }
      });
    }

    const incomes = events.filter(e => e.type === 'income') as Extract<SimEvent, { type: 'income' }>[];
    // stB(途中駅)では降りないので、収入は行き先stCに着いた1回だけ
    expect(incomes).toHaveLength(1);
    expect(incomes[0].passengers).toBe(10);
    // 運賃は乗車駅stA→降車駅stCの距離ぶん(途中駅までではない)
    expect(incomes[0].amount).toBeCloseTo(10 * FARE_PER_TILE * 10, 5);
  });

  it('乗換が必要な行き先の客は、乗換駅で降りてその駅の待ち客になる', () => {
    const { railMap, stations } = buildThreeStationLine();
    // g1は stA-stB、g2は stB-stC。stA→stCはstBで乗換が要る。
    const t1 = makeTrain({ id: 't1', x: 2, z: 0, schedule: [], groupId: 'g1' });
    const t2 = makeTrain({ id: 't2', x: 7, z: 0, schedule: [], groupId: 'g2' });
    const world = makeWorld(railMap, stations, [t1, t2], () => 1, []);
    world.groups = [
      { id: 'g1', name: 'g1', schedule: ['stA', 'stB'], headwaySeconds: 0, colour: '#fff' },
      { id: 'g2', name: 'g2', schedule: ['stB', 'stC'], headwaySeconds: 0, colour: '#fff' },
    ];
    seedWaiting(world, 'stA', 'stC', 10);

    for (let i = 0; i < 20000; i++) {
      const evs = stepWorld(world, 0.1);
      evs.forEach(e => {
        if (e.type === 'arrive') {
          const train = world.trains.find(t => t.id === e.trainId)!;
          const schedule = world.groups!.find(g => g.id === train.groupId)!.schedule;
          train.scheduleIndex = (train.scheduleIndex + 1) % schedule.length;
        }
      });
      // stBでstCゆきの待ち客に化けたら成功
      if ((world.demand?.get('stB') ?? []).some(c => c.destinationId === 'stC' && c.count > 0)) break;
    }

    const atB = world.demand?.get('stB') ?? [];
    expect(atB.find(c => c.destinationId === 'stC')?.count).toBe(10);
  });
});
