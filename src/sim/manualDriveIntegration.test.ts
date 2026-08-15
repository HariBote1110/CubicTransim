import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir, DIR } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld, MAX_SPEED_KMH } from './simulation';
import type { SimWorld } from './simulation';
import type { ManualDriveState } from './manualDrive';
import { createManualRideTally } from './manualDrive';
import { buildBlockIndex } from './blocks';
import { PLAY_MODE_PRESETS } from './gameRules';

// D4(手動運転)のstepWorld結合テスト。manualDrive.test.tsで固定した純関数
// (ノッチ割合・保安装置有効判定・SPAD強行の可否)がsimulation.tsへ正しく配線されて
// いることを、実際にstepWorldを回して確認する。

const connect = (map: Map<string, CellData>, a: { x: number; z: number }, b: { x: number; z: number }) => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dir = getDirFromVector(dx, dz);
  const oppDir = getOppositeDir(dir);
  const aKey = toKey(a.x, a.z);
  const aCell = map.get(aKey) || { type: 'rail' as const, connections: 0 };
  map.set(aKey, { ...aCell, connections: (aCell.connections || 0) | dir });
  const bKey = toKey(b.x, b.z);
  const bCell = map.get(bKey) || { type: 'rail' as const, connections: 0 };
  map.set(bKey, { ...bCell, connections: (bCell.connections || 0) | oppDir });
};

const makeTrain = (overrides: Partial<TrainData>): TrainData => ({
  id: 't1', x: 0, z: 0, schedule: [], scheduleIndex: 0, status: 'running', cars: 2, ...overrides,
});

const manualState = (overrides: Partial<ManualDriveState>): ManualDriveState => ({
  trainId: 't1', notch: 'N', difficulty: 'normal', tally: createManualRideTally(), ...overrides,
});

describe('D4手動運転: かんたん(ATO)はノッチが最高速度をキャップする', () => {
  it('P2ノッチではMAX_SPEED_KMHの40%を超えて加速しない(自動制御自体はそのまま)', () => {
    const cells = Array.from({ length: 30 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = new Map<string, CellData>();
    for (let i = 0; i < cells.length - 1; i++) connect(railMap, cells[i], cells[i + 1]);
    const startKey = toKey(0, 0);
    const endKey = toKey(29, 0);
    railMap.set(startKey, { ...railMap.get(startKey)!, type: 'station', stationId: 'stA' });
    railMap.set(endKey, { ...railMap.get(endKey)!, type: 'station', stationId: 'stB' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 29, z: 0 }], center: { x: 29, z: 0 }, platformDoors: 'none' }],
    ]);
    const train = makeTrain({ schedule: ['stB'], scheduleIndex: 0 });
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(), rng: () => 1, towns: [],
    };
    world.manualDrive = manualState({ notch: 'P2', difficulty: 'easy' });

    let maxSpeed = 0;
    for (let i = 0; i < 200; i++) {
      stepWorld(world, 0.2);
      const rt = world.runtimes.get('t1');
      if (rt) maxSpeed = Math.max(maxSpeed, rt.speedKmh);
    }
    expect(maxSpeed).toBeLessThanOrEqual(MAX_SPEED_KMH * 0.4 + 0.5);
    expect(maxSpeed).toBeGreaterThan(5); // ちゃんと加速はしている
  });
});

describe('D4手動運転: ふつう(ATS-P常時)は照査パターン超過で自動ブレーキが介入する', () => {
  it('駅の手前でP5(全力力行)を入れ続けても、hardEnvelopeを超えず停止点付近で止まる', () => {
    const cells = Array.from({ length: 12 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = new Map<string, CellData>();
    for (let i = 0; i < cells.length - 1; i++) connect(railMap, cells[i], cells[i + 1]);
    const startKey = toKey(0, 0);
    const endKey = toKey(11, 0);
    railMap.set(startKey, { ...railMap.get(startKey)!, type: 'station', stationId: 'stA' });
    railMap.set(endKey, { ...railMap.get(endKey)!, type: 'station', stationId: 'stB' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 11, z: 0 }], center: { x: 11, z: 0 }, platformDoors: 'none' }],
    ]);
    const train = makeTrain({ schedule: ['stB'], scheduleIndex: 0 });
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(), rng: () => 1, towns: [],
    };
    world.manualDrive = manualState({ notch: 'P5', difficulty: 'normal' });

    let overshotStation = false;
    for (let i = 0; i < 400; i++) {
      stepWorld(world, 0.1);
      const rt = world.runtimes.get('t1');
      if (rt && rt.grid.x > 11) overshotStation = true; // 保護があれば絶対に起きない
    }
    expect(overshotStation).toBe(false);
    // 保護が働いた形跡として、タリーのoverspeedSecondsは0のまま(常にhardEnvelope以内)。
    expect(world.manualDrive.tally.overspeedSeconds).toBe(0);
  });
});

describe('D4手動運転: むずかしいは無装備区間で自動ブレーキが働かず超過秒数が積み上がる', () => {
  it('保安装置なしでP5を入れ続けると、hardEnvelope超過がoverspeedSecondsに記録される', () => {
    const cells = Array.from({ length: 12 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = new Map<string, CellData>();
    for (let i = 0; i < cells.length - 1; i++) connect(railMap, cells[i], cells[i + 1]);
    const startKey = toKey(0, 0);
    const endKey = toKey(11, 0);
    railMap.set(startKey, { ...railMap.get(startKey)!, type: 'station', stationId: 'stA' });
    railMap.set(endKey, { ...railMap.get(endKey)!, type: 'station', stationId: 'stB' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 11, z: 0 }], center: { x: 11, z: 0 }, platformDoors: 'none' }],
    ]);
    const train = makeTrain({ schedule: ['stB'], scheduleIndex: 0 });
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(), rng: () => 1, towns: [],
    };
    world.manualDrive = manualState({ notch: 'P5', difficulty: 'hard' });

    for (let i = 0; i < 400; i++) {
      stepWorld(world, 0.1);
    }
    expect(world.manualDrive.tally.overspeedSeconds).toBeGreaterThan(0);
  });
});

describe('D4手動運転: むずかしいの信号強行(SPAD)', () => {
  // x=3に信号、x=5に(目的地ではない)中間駅stMid(駅はブロックを分割しない、blocks.ts)を
  // 置き、他列車'other'は信号の先のブロック内だがstMidより奥(x=8)を保有する。これにより
  // 「信号を出てstMidまでの区間」自体は'other'の保有セルと重ならないが、同じブロックに
  // 属するため通常はblocksSegmentEntryでブロックされる(=SPAD強行の意味がある)。
  const setupBlockedSingleTrack = () => {
    const cells = Array.from({ length: 10 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = new Map<string, CellData>();
    for (let i = 0; i < cells.length - 1; i++) connect(railMap, cells[i], cells[i + 1]);
    railMap.set(toKey(3, 0), { ...railMap.get(toKey(3, 0))!, signalDir: DIR.E });
    const startKey = toKey(0, 0);
    const midKey = toKey(5, 0);
    const endKey = toKey(9, 0);
    railMap.set(startKey, { ...railMap.get(startKey)!, type: 'station', stationId: 'stA' });
    railMap.set(midKey, { ...railMap.get(midKey)!, type: 'station', stationId: 'stMid' });
    railMap.set(endKey, { ...railMap.get(endKey)!, type: 'station', stationId: 'stB' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stMid', { id: 'stMid', name: 'Mid', cells: [{ x: 5, z: 0 }], center: { x: 5, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 9, z: 0 }], center: { x: 9, z: 0 }, platformDoors: 'none' }],
    ]);
    const train = makeTrain({ schedule: ['stB'], scheduleIndex: 0 });
    const s1Rules = { ...PLAY_MODE_PRESETS.light, signalling: 's1' as const };
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(), rng: () => 0, towns: [],
      rules: s1Rules, blocks: buildBlockIndex(railMap),
      // 信号の先の同じブロック(x=4..9、stMidは分割しない)を他列車'other'が保有=占有中。
      reservations: new Map([[toKey(8, 0), 'other']]),
    };
    return { world, train };
  };

  it('無装備・力行ノッチを入れ続けると、ブロック占有を無視して予約が伸び、事故イベントが発生する(rng=0で確実に発火)', () => {
    const { world } = setupBlockedSingleTrack();
    world.manualDrive = manualState({ notch: 'P5', difficulty: 'hard' });

    const allEvents = [];
    for (let i = 0; i < 100; i++) {
      allEvents.push(...stepWorld(world, 0.1));
    }
    const spadEvents = allEvents.filter(e => e.type === 'accident' && e.kind === 'spad');
    expect(spadEvents.length).toBeGreaterThan(0);
    // 予約が信号の先(index>=2、信号セル(3,0)がroute[2])のstMidまで伸びたことも確認する
    // ('other'が保有する(8,0)自体は要求した区間の外なのでtryReserve自体は成功する)。
    const rt = world.runtimes.get('t1')!;
    expect(rt.reservedEndIndex).toBeGreaterThanOrEqual(2);
  });

  it('保安装置(ATS-P)が地上・車上とも実際に装備されていれば、むずかしいでも信号を強行しない', () => {
    const { world, train } = setupBlockedSingleTrack();
    train.protection = 'ats-p';
    world.railMap.set(toKey(3, 0), { ...world.railMap.get(toKey(3, 0))!, protection: 'ats-p' });
    world.manualDrive = manualState({ notch: 'P5', difficulty: 'hard' });

    const allEvents = [];
    for (let i = 0; i < 100; i++) {
      allEvents.push(...stepWorld(world, 0.1));
    }
    const spadEvents = allEvents.filter(e => e.type === 'accident');
    expect(spadEvents.length).toBe(0);
    const rt = world.runtimes.get('t1')!;
    // 信号の先(index>=2)へは伸びていない(通常どおり待たされている)。
    expect(rt.reservedEndIndex).toBeLessThan(2);
  });
});

describe('D4手動運転: 停車精度スコア', () => {
  it('駅の手前でB7を入れて早めに停止すると、正のdistanceMでmanualStopイベントが発行される', () => {
    const cells = Array.from({ length: 20 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = new Map<string, CellData>();
    for (let i = 0; i < cells.length - 1; i++) connect(railMap, cells[i], cells[i + 1]);
    const startKey = toKey(0, 0);
    const endKey = toKey(19, 0);
    railMap.set(startKey, { ...railMap.get(startKey)!, type: 'station', stationId: 'stA' });
    railMap.set(endKey, { ...railMap.get(endKey)!, type: 'station', stationId: 'stB' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 19, z: 0 }], center: { x: 19, z: 0 }, platformDoors: 'none' }],
    ]);
    const train = makeTrain({ schedule: ['stB'], scheduleIndex: 0 });
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(), rng: () => 1, towns: [],
    };
    world.manualDrive = manualState({ notch: 'P3', difficulty: 'normal' });

    const allEvents = [];
    // 少し加速させてから、B7を入れっぱなしにして駅よりだいぶ手前で完全停止させる。
    for (let i = 0; i < 15; i++) allEvents.push(...stepWorld(world, 0.1));
    world.manualDrive.notch = 'B7';
    for (let i = 0; i < 200; i++) allEvents.push(...stepWorld(world, 0.1));

    const stopEvents = allEvents.filter(e => e.type === 'manualStop');
    expect(stopEvents.length).toBeGreaterThan(0);
    const first = stopEvents[0] as Extract<(typeof stopEvents)[number], { type: 'manualStop' }>;
    expect(first.distanceM).toBeGreaterThan(0); // 駅より手前で止まった(undershoot)
    expect(world.manualDrive.tally.stops).toBeGreaterThan(0);
  });
});
