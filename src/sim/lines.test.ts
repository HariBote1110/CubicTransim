import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData, LineData, ServiceData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld } from './simulation';
import {
  effectiveSchedule, headwayHoldSeconds, nextLineName, nextLineColour,
  departureKey, membersOf, LINE_COLOURS,
  findLine, findService, resolveAssignment, serviceStops, defaultServiceFor,
  nextStop,
  stopsOnCurrentRun,
  recordInterval,
  averageInterval,
  INTERVAL_SAMPLE_LIMIT,
  suggestsShuttle,
} from './lines';

const makeLine = (over: Partial<LineData> = {}): LineData => ({
  id: 'l1', name: '1系統', stops: ['stA', 'stB'], colour: LINE_COLOURS[0], ...over,
});

const makeService = (over: Partial<ServiceData> = {}): ServiceData => ({
  id: 's1', lineId: 'l1', name: '各停', skipStationIds: [], headwaySeconds: 0, ...over,
});

const makeTrain = (over: Partial<TrainData> = {}): TrainData => ({
  id: 't1', x: 0, z: 0, schedule: [], scheduleIndex: 0, status: 'running', cars: 2, ...over,
});

describe('路線/種別の純粋関数', () => {
  it('種別に所属していれば路線の運行表に従う', () => {
    const line = makeLine();
    const service = makeService();
    const train = makeTrain({ schedule: ['stZ'], serviceId: 's1' });
    expect(effectiveSchedule(train, [line], [service])).toEqual(['stA', 'stB']);
  });

  it('未所属なら列車自身の運行表に従う', () => {
    const train = makeTrain({ schedule: ['stZ'] });
    expect(effectiveSchedule(train, [makeLine()], [makeService()])).toEqual(['stZ']);
  });

  it('存在しない種別idを指していたら列車自身の運行表に落ちる', () => {
    const train = makeTrain({ schedule: ['stZ'], serviceId: 'missing' });
    expect(effectiveSchedule(train, [makeLine()], [makeService()])).toEqual(['stZ']);
  });

  it('種別が指す路線が存在しなければ列車自身の運行表に落ちる', () => {
    const train = makeTrain({ schedule: ['stZ'], serviceId: 's1' });
    const service = makeService({ lineId: 'missing-line' });
    expect(effectiveSchedule(train, [makeLine()], [service])).toEqual(['stZ']);
  });

  it('種別がskipStationIdsを持つと、通過駅を除いた運行表になる(快速)', () => {
    const line = makeLine({ id: 'l1', stops: ['stA', 'stB', 'stC'] });
    const rapid = makeService({ id: 'rapid', lineId: 'l1', name: '快速', skipStationIds: ['stB'] });
    const train = makeTrain({ serviceId: 'rapid' });
    expect(effectiveSchedule(train, [line], [rapid])).toEqual(['stA', 'stC']);
  });

  it('serviceStopsは種別のskipStationIdsを路線のstopsから除いたもの', () => {
    const line = makeLine({ stops: ['stA', 'stB', 'stC'] });
    const rapid = makeService({ skipStationIds: ['stB'] });
    expect(serviceStops(line, rapid)).toEqual(['stA', 'stC']);
  });

  it('resolveAssignmentは(路線,種別)の組を返す。未所属・不整合ならnull', () => {
    const line = makeLine();
    const service = makeService();
    const train = makeTrain({ serviceId: 's1' });
    expect(resolveAssignment(train, [line], [service])).toEqual({ line, service });
    expect(resolveAssignment(makeTrain(), [line], [service])).toBeNull();
  });

  it('defaultServiceForは各停・通過駅なし・発車間隔0の種別を作る', () => {
    const service = defaultServiceFor('l1');
    expect(service).toEqual({ id: 'l1:default', lineId: 'l1', name: '各停', skipStationIds: [], headwaySeconds: 0 });
  });

  it('発車間隔0なら待たない', () => {
    expect(headwayHoldSeconds(0, 100, 100)).toBe(0);
  });

  it('前続列車の発車記録が無ければ待たない', () => {
    expect(headwayHoldSeconds(60, undefined, 100)).toBe(0);
  });

  it('発車間隔に足りない分だけ待ち、経過すれば0になる', () => {
    expect(headwayHoldSeconds(60, 100, 120)).toBe(40);
    expect(headwayHoldSeconds(60, 100, 160)).toBe(0);
    expect(headwayHoldSeconds(60, 100, 200)).toBe(0);
  });

  it('名前と色は既存路線と重複しないものが選ばれる', () => {
    const lines = [makeLine({ id: 'a', name: '1系統', colour: LINE_COLOURS[0] })];
    expect(nextLineName(lines)).toBe('2系統');
    expect(nextLineColour(lines)).toBe(LINE_COLOURS[1]);
  });

  it('departureKeyは種別と駅の組で一意', () => {
    expect(departureKey('s1', 'stA')).not.toBe(departureKey('s1', 'stB'));
    expect(departureKey('s1', 'stA')).not.toBe(departureKey('s2', 'stA'));
  });

  it('membersOfは所属列車だけを返す', () => {
    const trains = [makeTrain({ id: 'a', serviceId: 's1' }), makeTrain({ id: 'b' }), makeTrain({ id: 'c', serviceId: 's1' })];
    expect(membersOf(trains, 's1').map(t => t.id)).toEqual(['a', 'c']);
  });

  it('findLine/findServiceはidで検索し、無ければundefined', () => {
    const line = makeLine();
    const service = makeService();
    expect(findLine([line], 'l1')).toBe(line);
    expect(findLine([line], 'missing')).toBeUndefined();
    expect(findService([service], 's1')).toBe(service);
    expect(findService([service], undefined)).toBeUndefined();
  });
});

// --- stepWorld との結合 ---

const buildRailMap = (cells: { x: number; z: number }[]) => {
  const map = new Map<string, CellData>();
  for (let i = 0; i < cells.length - 1; i++) {
    const curr = cells[i];
    const next = cells[i + 1];
    const dir = getDirFromVector(next.x - curr.x, next.z - curr.z);
    const oppDir = getOppositeDir(dir);
    const ck = toKey(curr.x, curr.z);
    const cc = map.get(ck) || { type: 'rail' as const, connections: 0 };
    map.set(ck, { ...cc, connections: (cc.connections || 0) | dir });
    const nk = toKey(next.x, next.z);
    const nc = map.get(nk) || { type: 'rail' as const, connections: 0 };
    map.set(nk, { ...nc, connections: (nc.connections || 0) | oppDir });
  }
  return map;
};

/** 0..len-1 の直線に、両端へ駅を置いた盤面。 */
const buildLine = (len: number) => {
  const cells = Array.from({ length: len }, (_, i) => ({ x: i, z: 0 }));
  const railMap = buildRailMap(cells);
  const aKey = toKey(0, 0);
  const bKey = toKey(len - 1, 0);
  railMap.set(aKey, { ...railMap.get(aKey)!, type: 'station', stationId: 'stA' });
  railMap.set(bKey, { ...railMap.get(bKey)!, type: 'station', stationId: 'stB' });
  const stations = new Map<string, StationData>([
    ['stA', { id: 'stA', name: 'A駅', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
    ['stB', { id: 'stB', name: 'B駅', cells: [{ x: len - 1, z: 0 }], center: { x: len - 1, z: 0 }, platformDoors: 'none' }],
  ]);
  return { railMap, stations };
};

describe('stepWorld: 路線/種別', () => {
  it('種別の運行表が列車自身の運行表より優先される(共有運行表)', () => {
    const { railMap, stations } = buildLine(8);
    // 列車自身の運行表は空だが、路線の運行表でB駅を目指す
    const train = makeTrain({ x: 0, z: 0, schedule: [], serviceId: 's1' });
    const line = makeLine({ id: 'l1', stops: ['stB'] });
    const service = makeService({ id: 's1', lineId: 'l1' });
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], lines: [line], services: [service], serviceDepartures: new Map(),
    };

    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 6000; i++) {
      stepWorld(world, 1 / 60);
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }
    expect(rt!.lastStopStationId).toBe('stB');
  });

  it('快速種別が通過駅を目的地に含めない(通過駅では乗降も発生しない)', () => {
    const { railMap, stations } = buildLine(8);
    // 路線はstA→stB→stCを想定したいところだがこの盤面はstA/stBの2駅のみなので、
    // ここではeffectiveScheduleの計算のみ(stepWorld統合はsimulation.test.tsで確認)を検証する。
    const line = makeLine({ id: 'l1', stops: ['stA', 'stB'] });
    const rapid = makeService({ id: 'rapid', lineId: 'l1', skipStationIds: ['stB'] });
    const train = makeTrain({ serviceId: 'rapid' });
    expect(effectiveSchedule(train, [line], [rapid])).toEqual(['stA']);
    void railMap; void stations;
  });

  it('発車間隔を設定すると、前続列車の発車から間隔が空くまで駅で待つ', () => {
    const { railMap, stations } = buildLine(8);
    const line = makeLine({ id: 'l1', stops: ['stB', 'stA'] });
    const service = makeService({ id: 's1', lineId: 'l1', headwaySeconds: 30 });
    const train = makeTrain({ x: 0, z: 0, schedule: [], serviceId: 's1' });
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], lines: [line], services: [service], serviceDepartures: new Map(),
      clock: { elapsed: 100 },
    };
    // 別の列車が「たった今」A駅を発車したことにする
    world.serviceDepartures!.set(departureKey('s1', 'stA'), 100);

    // まずA駅に停車させる(初期状態は走行中なので、A駅を目的地にして到着させる)
    world.lines![0].stops = ['stA'];
    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 3000; i++) {
      stepWorld(world, 1 / 60);
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }
    expect(rt!.lastStopStationId).toBe('stA');

    // 次の目的地をB駅にして、停車時間を消化させたあとの挙動を見る
    world.lines![0].stops = ['stA', 'stB'];
    train.scheduleIndex = 1;

    const startElapsed = world.clock!.elapsed;
    let heldTicks = 0;
    let departedAt: number | null = null;
    for (let i = 0; i < 6000; i++) {
      stepWorld(world, 1 / 60);
      rt = world.runtimes.get('t1')!;
      if (rt.debugStatus.startsWith('Holding for headway')) heldTicks++;
      if (departedAt === null && rt.route.length > 0) departedAt = world.clock!.elapsed;
      if (departedAt !== null) break;
    }

    expect(heldTicks).toBeGreaterThan(0);
    // 100秒に前続列車が発車 → 130秒まで発車できない
    expect(departedAt!).toBeGreaterThanOrEqual(130 - 0.1);
    expect(departedAt!).toBeLessThan(140);
    expect(startElapsed).toBeLessThan(130);
  });

  it('発車間隔0の種別では待たされない', () => {
    const { railMap, stations } = buildLine(8);
    const line = makeLine({ id: 'l1', stops: ['stA', 'stB'] });
    const service = makeService({ id: 's1', lineId: 'l1', headwaySeconds: 0 });
    const train = makeTrain({ x: 0, z: 0, schedule: [], serviceId: 's1' });
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], lines: [line], services: [service], serviceDepartures: new Map(),
      clock: { elapsed: 100 },
    };
    world.serviceDepartures!.set(departureKey('s1', 'stA'), 100);

    let held = false;
    for (let i = 0; i < 4000; i++) {
      stepWorld(world, 1 / 60);
      const rt = world.runtimes.get('t1')!;
      if (rt.debugStatus.startsWith('Holding for headway')) held = true;
      if (rt.lastStopStationId === 'stB') break;
    }
    expect(held).toBe(false);
  });

  it('発車すると「種別×駅」の最終発車時刻が記録される', () => {
    const { railMap, stations } = buildLine(8);
    const line = makeLine({ id: 'l1', stops: ['stA', 'stB'] });
    const service = makeService({ id: 's1', lineId: 'l1', headwaySeconds: 30 });
    const train = makeTrain({ x: 0, z: 0, schedule: [], serviceId: 's1' });
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], lines: [line], services: [service], serviceDepartures: new Map(),
    };

    // A駅へ到着 → 発車 の流れを回す
    for (let i = 0; i < 6000; i++) {
      const evs = stepWorld(world, 1 / 60);
      for (const e of evs) {
        if (e.type === 'arrive') train.scheduleIndex = (e.scheduleIndex + 1) % line.stops.length;
      }
      if (world.serviceDepartures!.has(departureKey('s1', 'stA'))) break;
    }
    expect(world.serviceDepartures!.has(departureKey('s1', 'stA'))).toBe(true);
  });

  it('同じ路線の異なる種別は、発車間隔を独立に記録する', () => {
    const rapid = departureKey('rapid', 'stA');
    const local = departureKey('local', 'stA');
    const intervals = new Map<string, number[]>();
    recordInterval(intervals, 'rapid', 'stA', 100, 160);
    recordInterval(intervals, 'local', 'stA', 100, 130);
    expect(intervals.get(rapid)).toEqual([60]);
    expect(intervals.get(local)).toEqual([30]);
  });
});

describe('運行モード(環状/折返し)', () => {
  it('環状運転では最後の駅の次は先頭の駅に戻る', () => {
    expect(nextStop({ index: 0, direction: 1 }, 3, 'loop')).toEqual({ index: 1, direction: 1 });
    expect(nextStop({ index: 2, direction: 1 }, 3, 'loop')).toEqual({ index: 0, direction: 1 });
  });

  it('折返し運転では終端で向きが反転する', () => {
    expect(nextStop({ index: 1, direction: 1 }, 3, 'shuttle')).toEqual({ index: 2, direction: 1 });
    // 終端(index=2)に着いたら折り返して1つ戻る
    expect(nextStop({ index: 2, direction: 1 }, 3, 'shuttle')).toEqual({ index: 1, direction: -1 });
    // 始端(index=0)でも同様に向きが戻る
    expect(nextStop({ index: 0, direction: -1 }, 3, 'shuttle')).toEqual({ index: 1, direction: 1 });
  });

  it('折返し運転で駅が2つなら2駅を往復し続ける', () => {
    let state = { index: 0, direction: 1 as 1 | -1 };
    const visited: number[] = [];
    for (let i = 0; i < 4; i++) {
      state = nextStop(state, 2, 'shuttle');
      visited.push(state.index);
    }
    expect(visited).toEqual([1, 0, 1, 0]);
  });

  it('停車駅が1つ以下なら動かない', () => {
    expect(nextStop({ index: 0, direction: 1 }, 1, 'shuttle')).toEqual({ index: 0, direction: 1 });
    expect(nextStop({ index: 0, direction: 1 }, 0, 'loop')).toEqual({ index: 0, direction: 1 });
  });
});

describe('この先(今の片道)の停車駅', () => {
  const schedule = ['A', 'B', 'C', 'D'];

  it('環状運転では現在地の次から一周ぶんが並ぶ', () => {
    expect(stopsOnCurrentRun(schedule, { index: 2, direction: 1 }, 'loop')).toEqual(['D', 'A', 'B', 'C']);
  });

  it('折返し運転では終端までで打ち切る(折り返した先は含めない)', () => {
    expect(stopsOnCurrentRun(schedule, { index: 1, direction: 1 }, 'shuttle')).toEqual(['C', 'D']);
  });

  it('折返し運転で終端にいるときは、折り返した先の全駅が並ぶ', () => {
    expect(stopsOnCurrentRun(schedule, { index: 3, direction: 1 }, 'shuttle')).toEqual(['C', 'B', 'A']);
  });
});

describe('実績の運転間隔', () => {
  it('同じ駅を続けて発車した間隔を記録する', () => {
    const intervals = new Map<string, number[]>();
    recordInterval(intervals, 's1', 'stA', 100, 160);
    expect(intervals.get(departureKey('s1', 'stA'))).toEqual([60]);
  });

  it('初回の発車(前回の記録が無い)は間隔にならない', () => {
    const intervals = new Map<string, number[]>();
    recordInterval(intervals, 's1', 'stA', undefined, 160);
    expect(intervals.get(departureKey('s1', 'stA'))).toBeUndefined();
  });

  it('直近の数回ぶんだけを残す', () => {
    const intervals = new Map<string, number[]>();
    for (let i = 1; i <= INTERVAL_SAMPLE_LIMIT + 3; i++) {
      recordInterval(intervals, 's1', 'stA', i * 10, i * 10 + 10);
    }
    expect(intervals.get(departureKey('s1', 'stA'))!.length).toBe(INTERVAL_SAMPLE_LIMIT);
  });

  it('種別全体の平均運転間隔を出す(記録が無ければnull)', () => {
    const intervals = new Map<string, number[]>([
      [departureKey('s1', 'stA'), [60, 80]],
      [departureKey('s1', 'stB'), [100]],
      [departureKey('s2', 'stA'), [10]],
    ]);
    expect(averageInterval(intervals, 's1')).toBeCloseTo(80, 5);
    expect(averageInterval(intervals, 's3')).toBeNull();
  });
});

// テスト用: セル列から線路を作り、指定インデックスのセルを駅にする。
const buildTestLine = (
  cells: { x: number; z: number }[],
  places: [string, number][]
) => {
  const railMap = new Map<string, CellData>();
  const connect = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    const dir = getDirFromVector(b.x - a.x, b.z - a.z);
    const aKey = toKey(a.x, a.z);
    const bKey = toKey(b.x, b.z);
    const aCell = railMap.get(aKey) ?? { type: 'rail' as const, connections: 0 };
    railMap.set(aKey, { ...aCell, connections: (aCell.connections ?? 0) | dir });
    const bCell = railMap.get(bKey) ?? { type: 'rail' as const, connections: 0 };
    railMap.set(bKey, { ...bCell, connections: (bCell.connections ?? 0) | getOppositeDir(dir) });
  };
  for (let i = 0; i + 1 < cells.length; i++) connect(cells[i], cells[i + 1]);

  const stations = new Map<string, StationData>();
  for (const [id, index] of places) {
    const cell = cells[index];
    const key = toKey(cell.x, cell.z);
    railMap.set(key, { ...railMap.get(key)!, type: 'station', stationId: id });
    stations.set(id, { id, name: id, cells: [cell], center: cell, platformDoors: 'none' });
  }
  return { railMap, stations };
};

describe('行き止まり路線の判定', () => {
  // A --- B --- C の一直線(行き止まり)
  const straight = () => {
    const cells = Array.from({ length: 11 }, (_, i) => ({ x: i, z: 0 }));
    return buildTestLine(cells, [['A', 0], ['B', 5], ['C', 10]]);
  };

  it('一直線の路線を環状運転にすると、終端から始発へ戻る回送が長いので折返しを勧める', () => {
    const { railMap, stations } = straight();
    expect(suggestsShuttle(['A', 'B', 'C'], railMap, stations)).toBe(true);
  });

  it('環状線(終端どうしが繋がっている)なら勧めない', () => {
    const ring: { x: number; z: number }[] = [];
    for (let x = 0; x <= 5; x++) ring.push({ x, z: 0 });
    for (let z = 1; z <= 5; z++) ring.push({ x: 5, z });
    for (let x = 4; x >= 0; x--) ring.push({ x, z: 5 });
    for (let z = 4; z >= 0; z--) ring.push({ x: 0, z });
    const { railMap, stations } = buildTestLine(ring, [['A', 0], ['B', 5], ['C', 10], ['D', 15]]);
    expect(suggestsShuttle(['A', 'B', 'C', 'D'], railMap, stations)).toBe(false);
  });

  it('停車駅が2つ以下なら勧めない(どちらのモードでも同じ動きになる)', () => {
    const { railMap, stations } = straight();
    expect(suggestsShuttle(['A', 'B'], railMap, stations)).toBe(false);
  });
});
