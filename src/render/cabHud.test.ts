import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir, DIR } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld, MAX_SPEED_KMH } from '../sim/simulation';
import type { SimWorld, TrainRuntime } from '../sim/simulation';
import { railWeightSpeedCapKmh } from '../sim/physics';
import { PLAY_MODE_PRESETS } from '../sim/gameRules';
import { buildBlockIndex } from '../sim/blocks';
import { computeCabHud } from './cabHud';

// D3: 運転台HUDの純関数テスト。simulation.tsのstepTrainが内部で使っている
// distanceAlongRouteTo/distanceToStopPointをそのまま再利用する前提なので、
// ここでは「obstacleの分類(station/signal)」「信号現示(reservedEndIndexとの比較)」
// 「デッドセクション予告(isDeadSectionBoundaryの先読み)」の組み立てだけを検証する。

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
  id: 't1', x: 0, z: 0, schedule: [], scheduleIndex: 0, status: 'running', cars: 4, ...overrides,
});

const makeWorld = (
  railMap: Map<string, CellData>, stations: Map<string, StationData>, trains: TrainData[],
): SimWorld => ({
  railMap, stations, trains, runtimes: new Map(), waiting: new Map(), rng: () => 1, towns: [],
});

/** テスト用に最小限のTrainRuntimeを直接組み立てる(純粋な組み立てロジックだけを見るため)。 */
const makeRuntime = (overrides: Partial<TrainRuntime>): TrainRuntime => ({
  id: 't1',
  grid: { x: 0, z: 0 },
  prevGrid: null,
  progress: 0,
  speedKmh: 42,
  route: [],
  reservedEndIndex: -1,
  trail: [],
  pathHistory: [],
  stopRemaining: 0,
  waitTimer: 0,
  debugStatus: '',
  renderPos: { x: 0, y: 0.5, z: 0 },
  renderTarget: null,
  passengers: 0,
  lastStopStationId: null,
  haltRemaining: 0,
  ...overrides,
});

describe('computeCabHud (D3 運転台HUD)', () => {
  it('存在しない列車IDにはnullを返す', () => {
    const world = makeWorld(new Map(), new Map(), []);
    expect(computeCabHud(world, 'no-such-train')).toBeNull();
  });

  it('speedKmhをそのまま返し、speedLimitKmhはsimulation.tsのMAX_SPEED_KMHを再利用する', () => {
    const railMap = buildRailMap([{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    const world = makeWorld(railMap, new Map(), []);
    world.runtimes.set('t1', makeRuntime({ speedKmh: 63 }));
    const hud = computeCabHud(world, 't1');
    expect(hud).not.toBeNull();
    expect(hud!.speedKmh).toBe(63);
    expect(hud!.speedLimitKmh).toBe(MAX_SPEED_KMH);
  });

  it('経路が空なら次の停止点までの距離はnull', () => {
    const railMap = buildRailMap([{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    const world = makeWorld(railMap, new Map(), []);
    world.runtimes.set('t1', makeRuntime({ route: [] }));
    expect(computeCabHud(world, 't1')!.nextStopDistanceM).toBeNull();
  });

  it('予約が経路末尾まで届いている(駅停止)なら、その分の距離を返す', () => {
    const railMap = buildRailMap([{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }]);
    const world = makeWorld(railMap, new Map(), []);
    const route = [{ x: 1, z: 0 }, { x: 2, z: 0 }];
    world.runtimes.set('t1', makeRuntime({
      grid: { x: 0, z: 0 }, progress: 0, route, reservedEndIndex: route.length - 1,
    }));
    const hud = computeCabHud(world, 't1')!;
    expect(hud.nextStopDistanceM).not.toBeNull();
    expect(hud.nextStopDistanceM!).toBeGreaterThan(0);
  });

  it('信号手前で予約が止まっている(reservedEndIndexが信号セルより手前)場合、次信号は停止(red)', () => {
    const cells = Array.from({ length: 6 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    // (3,0)に信号を置く。route=[1,2,3,4,5]のindex2が信号セル。
    railMap.set(toKey(3, 0), { ...railMap.get(toKey(3, 0))!, signalDir: DIR.E });
    const world = makeWorld(railMap, new Map(), []);
    const route = [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 }];
    // 信号の1つ手前(index1=(2,0))までしか予約できていない = 信号の先へ進めない。
    world.runtimes.set('t1', makeRuntime({ grid: { x: 0, z: 0 }, route, reservedEndIndex: 1 }));
    const hud = computeCabHud(world, 't1')!;
    expect(hud.nextSignalAspect).toBe('red');
  });

  it('信号を含む区間まで予約が伸びている場合、次信号は開通(green)', () => {
    const cells = Array.from({ length: 6 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    railMap.set(toKey(3, 0), { ...railMap.get(toKey(3, 0))!, signalDir: DIR.E });
    const world = makeWorld(railMap, new Map(), []);
    const route = [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 }];
    // 信号セル(index2)以降まで予約が伸びている = 信号を通過してよい。
    world.runtimes.set('t1', makeRuntime({ grid: { x: 0, z: 0 }, route, reservedEndIndex: 3 }));
    const hud = computeCabHud(world, 't1')!;
    expect(hud.nextSignalAspect).toBe('green');
  });

  it('先読み区間に信号が無ければ次信号はnull', () => {
    const cells = Array.from({ length: 4 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    const world = makeWorld(railMap, new Map(), []);
    const route = [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }];
    world.runtimes.set('t1', makeRuntime({ grid: { x: 0, z: 0 }, route, reservedEndIndex: 0 }));
    expect(computeCabHud(world, 't1')!.nextSignalAspect).toBeNull();
  });

  it('先読み区間内に交直デッドセクション境界があればdeadSectionAhead=true', () => {
    const cells = Array.from({ length: 5 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    railMap.set(toKey(1, 0), { ...railMap.get(toKey(1, 0))!, electrified: 'dc' });
    railMap.set(toKey(2, 0), { ...railMap.get(toKey(2, 0))!, electrified: 'ac' });
    const world = makeWorld(railMap, new Map(), []);
    const route = [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    world.runtimes.set('t1', makeRuntime({ grid: { x: 0, z: 0 }, route, reservedEndIndex: -1 }));
    expect(computeCabHud(world, 't1')!.deadSectionAhead).toBe(true);
  });

  it('先読み区間内にデッドセクションが無ければdeadSectionAhead=false', () => {
    const cells = Array.from({ length: 5 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    for (const c of cells) railMap.set(toKey(c.x, c.z), { ...railMap.get(toKey(c.x, c.z))!, electrified: 'dc' });
    const world = makeWorld(railMap, new Map(), []);
    const route = [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    world.runtimes.set('t1', makeRuntime({ grid: { x: 0, z: 0 }, route, reservedEndIndex: -1 }));
    expect(computeCabHud(world, 't1')!.deadSectionAhead).toBe(false);
  });

  it('rules.trackClasses=trueなら現在セルのレール種別に応じた速度上限(railWeightSpeedCapKmh)を返す', () => {
    const railMap = buildRailMap([{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    railMap.set(toKey(0, 0), { ...railMap.get(toKey(0, 0))!, railWeight: 37 });
    const world = makeWorld(railMap, new Map(), []);
    world.rules = { ...PLAY_MODE_PRESETS.realistic, trackClasses: true };
    world.runtimes.set('t1', makeRuntime({ grid: { x: 0, z: 0 } }));
    const hud = computeCabHud(world, 't1')!;
    expect(hud.speedLimitKmh).toBe(railWeightSpeedCapKmh(37));
    expect(hud.speedLimitKmh).toBeLessThan(MAX_SPEED_KMH);
  });

  it('rules.trackClasses=falseならレール種別を無視してMAX_SPEED_KMHを返す(フォールバック)', () => {
    const railMap = buildRailMap([{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    railMap.set(toKey(0, 0), { ...railMap.get(toKey(0, 0))!, railWeight: 37 });
    const world = makeWorld(railMap, new Map(), []);
    world.rules = { ...PLAY_MODE_PRESETS.light, trackClasses: false };
    world.runtimes.set('t1', makeRuntime({ grid: { x: 0, z: 0 } }));
    expect(computeCabHud(world, 't1')!.speedLimitKmh).toBe(MAX_SPEED_KMH);
  });

  it('S1: ブロックが他列車に占有されていれば、reservedEndIndexがまだ信号に届いていなくても次信号は停止(red)', () => {
    const cells = Array.from({ length: 8 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    // (3,0)に信号。0..2が手前ブロック、4..7が信号の先のブロック。
    railMap.set(toKey(3, 0), { ...railMap.get(toKey(3, 0))!, signalDir: DIR.E });
    const world = makeWorld(railMap, new Map(), []);
    world.rules = { ...PLAY_MODE_PRESETS.light, signalling: 's1' };
    world.blocks = buildBlockIndex(railMap);
    // 信号の先のブロック(4,0)を別列車'other'が予約保有している(=占有中)。
    world.reservations = new Map([[toKey(4, 0), 'other']]);
    const route = [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 }];
    // reservedEndIndexはまだ-1(遠方で延長を試みていないだけ)。旧実装ならこれだけでredになるが、
    // ここで確認したいのは「ブロックが実際に空いていればreservedEndIndexの遅れに関わらずgreenになる」
    // 対の性質なので、このテストではブロックを塞いだ状態でredのままであることを確認する。
    world.runtimes.set('t1', makeRuntime({ grid: { x: 0, z: 0 }, route, reservedEndIndex: -1 }));
    expect(computeCabHud(world, 't1')!.nextSignalAspect).toBe('red');
  });

  it('S1: ブロックが空いていれば、reservedEndIndexが信号にまだ届いていなくても次信号は開通(green)', () => {
    const cells = Array.from({ length: 8 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    railMap.set(toKey(3, 0), { ...railMap.get(toKey(3, 0))!, signalDir: DIR.E });
    const world = makeWorld(railMap, new Map(), []);
    world.rules = { ...PLAY_MODE_PRESETS.light, signalling: 's1' };
    world.blocks = buildBlockIndex(railMap);
    // 予約は無し(誰もブロックを保有していない)。
    world.reservations = new Map();
    const route = [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 }];
    // reservedEndIndex=-1のまま(=まだ延長を試みていないだけ)だが、ブロックは実際には空いている。
    // 旧実装(reservedEndIndex比較のみ)ならここでredと誤判定するが、blocksSegmentEntryを
    // 直接評価する新実装ではgreenになるはず。
    world.runtimes.set('t1', makeRuntime({ grid: { x: 0, z: 0 }, route, reservedEndIndex: -1 }));
    expect(computeCabHud(world, 't1')!.nextSignalAspect).toBe('green');
  });

  it('実際にstepWorldで走らせても例外なくHUDが計算できる(統合スモーク)', () => {
    const cells = Array.from({ length: 20 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    const startKey = toKey(0, 0);
    const endKey = toKey(19, 0);
    railMap.set(startKey, { ...railMap.get(startKey)!, type: 'station', stationId: 'stA' });
    railMap.set(endKey, { ...railMap.get(endKey)!, type: 'station', stationId: 'stB' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 19, z: 0 }], center: { x: 19, z: 0 }, platformDoors: 'none' }],
    ]);
    const train = makeTrain({ x: 0, z: 0, schedule: ['stB'], scheduleIndex: 0 });
    const world = makeWorld(railMap, stations, [train]);
    for (let i = 0; i < 100; i++) {
      stepWorld(world, 0.1);
      const hud = computeCabHud(world, 't1');
      expect(hud).not.toBeNull();
      expect(Number.isFinite(hud!.speedKmh)).toBe(true);
    }
  });
});
