import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData, TrainGroupData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld } from './simulation';
import {
  effectiveSchedule, headwayHoldSeconds, nextGroupName, nextGroupColour,
  departureKey, membersOf, GROUP_COLOURS,
  nextStop,
  upcomingStops,
} from './groups';

const makeGroup = (over: Partial<TrainGroupData> = {}): TrainGroupData => ({
  id: 'g1', name: '1系統', schedule: ['stA', 'stB'], headwaySeconds: 0, colour: GROUP_COLOURS[0], ...over,
});

const makeTrain = (over: Partial<TrainData> = {}): TrainData => ({
  id: 't1', x: 0, z: 0, schedule: [], scheduleIndex: 0, status: 'running', cars: 2, ...over,
});

describe('運用グループの純粋関数', () => {
  it('グループに所属していればグループの運行表に従う', () => {
    const group = makeGroup();
    const train = makeTrain({ schedule: ['stZ'], groupId: 'g1' });
    expect(effectiveSchedule(train, [group])).toEqual(['stA', 'stB']);
  });

  it('未所属なら列車自身の運行表に従う', () => {
    const train = makeTrain({ schedule: ['stZ'] });
    expect(effectiveSchedule(train, [makeGroup()])).toEqual(['stZ']);
  });

  it('存在しないグループidを指していたら列車自身の運行表に落ちる', () => {
    const train = makeTrain({ schedule: ['stZ'], groupId: 'missing' });
    expect(effectiveSchedule(train, [makeGroup()])).toEqual(['stZ']);
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

  it('名前と色は既存グループと重複しないものが選ばれる', () => {
    const groups = [makeGroup({ id: 'a', name: '1系統', colour: GROUP_COLOURS[0] })];
    expect(nextGroupName(groups)).toBe('2系統');
    expect(nextGroupColour(groups)).toBe(GROUP_COLOURS[1]);
  });

  it('departureKeyはグループと駅の組で一意', () => {
    expect(departureKey('g1', 'stA')).not.toBe(departureKey('g1', 'stB'));
    expect(departureKey('g1', 'stA')).not.toBe(departureKey('g2', 'stA'));
  });

  it('membersOfは所属列車だけを返す', () => {
    const trains = [makeTrain({ id: 'a', groupId: 'g1' }), makeTrain({ id: 'b' }), makeTrain({ id: 'c', groupId: 'g1' })];
    expect(membersOf(trains, 'g1').map(t => t.id)).toEqual(['a', 'c']);
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

describe('stepWorld: 運用グループ', () => {
  it('グループの運行表が列車自身の運行表より優先される(共有運行表)', () => {
    const { railMap, stations } = buildLine(8);
    // 列車自身の運行表は空だが、グループの運行表でB駅を目指す
    const train = makeTrain({ x: 0, z: 0, schedule: [], groupId: 'g1' });
    const group = makeGroup({ id: 'g1', schedule: ['stB'] });
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], groups: [group], groupDepartures: new Map(),
    };

    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 6000; i++) {
      stepWorld(world, 1 / 60);
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }
    expect(rt!.lastStopStationId).toBe('stB');
  });

  it('発車間隔を設定すると、前続列車の発車から間隔が空くまで駅で待つ', () => {
    const { railMap, stations } = buildLine(8);
    const group = makeGroup({ id: 'g1', schedule: ['stB', 'stA'], headwaySeconds: 30 });
    const train = makeTrain({ x: 0, z: 0, schedule: [], groupId: 'g1' });
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], groups: [group], groupDepartures: new Map(),
      clock: { elapsed: 100 },
    };
    // 別の列車が「たった今」A駅を発車したことにする
    world.groupDepartures!.set(departureKey('g1', 'stA'), 100);

    // まずA駅に停車させる(初期状態は走行中なので、A駅を目的地にして到着させる)
    world.groups![0].schedule = ['stA'];
    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 3000; i++) {
      stepWorld(world, 1 / 60);
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }
    expect(rt!.lastStopStationId).toBe('stA');

    // 次の目的地をB駅にして、停車時間を消化させたあとの挙動を見る
    world.groups![0].schedule = ['stA', 'stB'];
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

  it('発車間隔0のグループでは待たされない', () => {
    const { railMap, stations } = buildLine(8);
    const group = makeGroup({ id: 'g1', schedule: ['stA', 'stB'], headwaySeconds: 0 });
    const train = makeTrain({ x: 0, z: 0, schedule: [], groupId: 'g1' });
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], groups: [group], groupDepartures: new Map(),
      clock: { elapsed: 100 },
    };
    world.groupDepartures!.set(departureKey('g1', 'stA'), 100);

    let held = false;
    for (let i = 0; i < 4000; i++) {
      stepWorld(world, 1 / 60);
      const rt = world.runtimes.get('t1')!;
      if (rt.debugStatus.startsWith('Holding for headway')) held = true;
      if (rt.lastStopStationId === 'stB') break;
    }
    expect(held).toBe(false);
  });

  it('発車すると「グループ×駅」の最終発車時刻が記録される', () => {
    const { railMap, stations } = buildLine(8);
    const group = makeGroup({ id: 'g1', schedule: ['stA', 'stB'], headwaySeconds: 30 });
    const train = makeTrain({ x: 0, z: 0, schedule: [], groupId: 'g1' });
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], groups: [group], groupDepartures: new Map(),
    };

    // A駅へ到着 → 発車 の流れを回す
    for (let i = 0; i < 6000; i++) {
      const evs = stepWorld(world, 1 / 60);
      for (const e of evs) {
        if (e.type === 'arrive') train.scheduleIndex = (e.scheduleIndex + 1) % group.schedule.length;
      }
      if (world.groupDepartures!.has(departureKey('g1', 'stA'))) break;
    }
    expect(world.groupDepartures!.has(departureKey('g1', 'stA'))).toBe(true);
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

describe('この先の停車駅', () => {
  const schedule = ['A', 'B', 'C', 'D'];

  it('環状運転では現在地の次から一周ぶんが並ぶ', () => {
    expect(upcomingStops(schedule, { index: 2, direction: 1 }, 'loop')).toEqual(['D', 'A', 'B']);
  });

  it('折返し運転では終端で折り返した並びになる', () => {
    expect(upcomingStops(schedule, { index: 2, direction: 1 }, 'shuttle')).toEqual(['D', 'C', 'B', 'A']);
  });
});
