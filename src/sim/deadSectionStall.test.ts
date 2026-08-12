import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld, STALL_SPEED_THRESHOLD_KMH } from './simulation';
import type { SimWorld, SimEvent } from './simulation';
import { STALL_RECOVERY_SECONDS, STALL_RESCUE_COST } from './economy';

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

// 境界(dc→ac)を先頭セルのすぐ隣に置いた直線。列車は静止発進(速度0)から
// すぐに境界へ差し掛かるため、「進入速度が遅い(=歩く速さ未満)」ケースを
// 決定的に再現できる。境界以降は最後までacにして交直流車が最後まで走れるようにする。
const buildImmediateBoundaryLine = (length: number, stationId: string) => {
  const cells = Array.from({ length }, (_, i) => ({ x: i, z: 0 }));
  const railMap = buildRailMap(cells);
  for (const cell of railMap.values()) cell.electrified = 'dc';
  for (let i = 1; i < length; i++) railMap.get(toKey(i, 0))!.electrified = 'ac';
  const lastKey = toKey(length - 1, 0);
  railMap.set(lastKey, { ...railMap.get(lastKey)!, type: 'station', stationId });
  const stations = new Map<string, StationData>([
    [stationId, { id: stationId, name: 'A', cells: [{ x: length - 1, z: 0 }, { x: length - 1, z: 1 }], center: { x: length - 1, z: 0 }, platformDoors: 'none' }],
  ]);
  return { railMap, stations };
};

// 境界(dc→ac)を先頭からかなり離れた位置に置いた直線。列車は境界に達するまでの
// 距離で十分加速でき、「進入速度が速い(=最高速度付近)」ケースを再現する。
const buildFarBoundaryLine = (length: number, boundaryAt: number, stationId: string) => {
  const cells = Array.from({ length }, (_, i) => ({ x: i, z: 0 }));
  const railMap = buildRailMap(cells);
  for (const cell of railMap.values()) cell.electrified = 'dc';
  for (let i = boundaryAt; i < length; i++) railMap.get(toKey(i, 0))!.electrified = 'ac';
  const lastKey = toKey(length - 1, 0);
  railMap.set(lastKey, { ...railMap.get(lastKey)!, type: 'station', stationId });
  const stations = new Map<string, StationData>([
    [stationId, { id: stationId, name: 'A', cells: [{ x: length - 1, z: 0 }, { x: length - 1, z: 1 }], center: { x: length - 1, z: 0 }, platformDoors: 'none' }],
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

const makeWorld = (
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  trains: TrainData[]
): SimWorld => ({
  railMap, stations, trains, runtimes: new Map(), waiting: new Map(), rng: () => 1,
});

const runTicks = (world: SimWorld, dt: number, count: number): SimEvent[] => {
  const events: SimEvent[] = [];
  for (let i = 0; i < count; i++) events.push(...stepWorld(world, dt));
  return events;
};

const BOUNDARIES_RULES = { gauge: true, extendedGauges: false, electrification: 'boundaries' as const, signalling: 's0' as const, trackClasses: false };
const NORMAL_RULES = { gauge: true, extendedGauges: false, electrification: 'modes' as const, signalling: 's0' as const, trackClasses: false };

describe('デッドセクション失速(PM3フォローアップ)', () => {
  it('遅い進入(境界がすぐ隣、静止発進)は失速し、debugStatusに失速が現れる', () => {
    const { railMap, stations } = buildImmediateBoundaryLine(8, 'stA');
    const train = makeTrain({ schedule: ['stA'], power: 'electric-acdc' });
    const world = makeWorld(railMap, stations, [train]);
    world.rules = BOUNDARIES_RULES;

    runTicks(world, 0.1, 20); // 2秒ぶん。まだ救援(15秒)には届かない。
    const rt = world.runtimes.get('t1')!;
    expect(rt.speedKmh).toBeLessThan(STALL_SPEED_THRESHOLD_KMH);
    expect(rt.debugStatus).toContain('失速');
    expect(rt.stalledSeconds).toBeGreaterThan(0);
  });

  it('失速からSTALL_RECOVERY_SECONDS経つと救援イベントが1回だけ発生し、以降クロールで走り出す', () => {
    const { railMap, stations } = buildImmediateBoundaryLine(20, 'stA');
    const train = makeTrain({ schedule: ['stA'], power: 'electric-acdc' });
    const world = makeWorld(railMap, stations, [train]);
    world.rules = BOUNDARIES_RULES;

    const dt = 0.1;
    const ticksToRecover = Math.ceil(STALL_RECOVERY_SECONDS / dt) + 5;
    const events = runTicks(world, dt, ticksToRecover);

    const rescueEvents = events.filter(e => e.type === 'stallRescue');
    expect(rescueEvents.length).toBe(1);
    expect(rescueEvents[0]).toMatchObject({ trainId: 't1', penalty: STALL_RESCUE_COST });

    const rt = world.runtimes.get('t1')!;
    expect(rt.stallRecovered).toBe(true);

    // さらに進めると速度が出始める(クロールで牽引力が戻っている)。
    runTicks(world, dt, 50);
    const rtAfter = world.runtimes.get('t1')!;
    expect(rtAfter.speedKmh).toBeGreaterThan(0);

    // 2回目の救援は発生しない(1回だけ課金)。
    const moreEvents = runTicks(world, dt, ticksToRecover);
    expect(moreEvents.filter(e => e.type === 'stallRescue').length).toBe(0);
  });

  it('速い進入(境界がずっと先、十分加速してから通過)は失速しない', () => {
    const { railMap, stations } = buildFarBoundaryLine(60, 40, 'stA');
    const train = makeTrain({ schedule: ['stA'], power: 'electric-acdc' });
    const world = makeWorld(railMap, stations, [train]);
    world.rules = BOUNDARIES_RULES;

    const dt = 0.1;
    let sawBoundary = false;
    let stalled = false;
    for (let i = 0; i < 3000; i++) {
      stepWorld(world, dt);
      const rt = world.runtimes.get('t1')!;
      if (rt.grid.x === 39 && rt.route[0]?.x === 40) {
        sawBoundary = true;
        if (rt.debugStatus.includes('失速')) stalled = true;
      }
      if ((rt.stalledSeconds ?? 0) > 0) stalled = true;
      if (rt.stopRemaining > 0) break;
    }
    expect(sawBoundary).toBe(true);
    expect(stalled).toBe(false);
  });

  it('気動車はデッドセクション失速の影響を受けない', () => {
    const { railMap, stations } = buildImmediateBoundaryLine(20, 'stA');
    const train = makeTrain({ schedule: ['stA'], power: 'diesel' });
    const world = makeWorld(railMap, stations, [train]);
    world.rules = BOUNDARIES_RULES;

    const dt = 0.1;
    runTicks(world, dt, Math.ceil(STALL_RECOVERY_SECONDS / dt) + 20);
    const rt = world.runtimes.get('t1')!;
    expect(rt.stalledSeconds ?? 0).toBe(0);
    expect(rt.debugStatus).not.toContain('失速');
  });

  it('electrification=modes(アドバンスド未満)では失速機構自体が働かない', () => {
    const { railMap, stations } = buildImmediateBoundaryLine(20, 'stA');
    const train = makeTrain({ schedule: ['stA'], power: 'electric-acdc' });
    const world = makeWorld(railMap, stations, [train]);
    world.rules = NORMAL_RULES;

    const dt = 0.1;
    runTicks(world, dt, Math.ceil(STALL_RECOVERY_SECONDS / dt) + 20);
    const rt = world.runtimes.get('t1')!;
    expect(rt.stalledSeconds ?? 0).toBe(0);
    expect(rt.debugStatus).not.toContain('失速');
  });
});
