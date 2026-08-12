import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir, DIR } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld, SimEvent } from './simulation';
import { buildBlockIndex } from './blocks';
import { PLAY_MODE_PRESETS } from './gameRules';
import { reservationKey } from './reservation';

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
  id: 't', x: 0, z: 0, schedule: [], scheduleIndex: 0, status: 'running', cars: 2, ...overrides,
});

const s2Rules = { ...PLAY_MODE_PRESETS.light, signalling: 's2' as const };
const s1Rules = { ...PLAY_MODE_PRESETS.light, signalling: 's1' as const };

// 2本の独立した進入線(z=0側/z=1側)がそれぞれ場内信号を通って、内部でクロスオーバーに
// よって1つの連結ブロックにまとめられた「共通の駅構内ブロック」へ合流するレイアウト。
// stW1(0,0)->...->signal(5,0)home->platform1(6..9,0)=stP1
// stW2(0,1)->...->signal(5,1)home->platform2(6..9,1)=stP2
// platform1とplatform2は(6,0)-(6,1)のクロスオーバーで1つのブロックになる。
const buildStationLayout = (kind: 'home' | undefined) => {
  const railMap = new Map<string, CellData>();
  for (let x = 0; x < 5; x++) connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
  for (let x = 0; x < 5; x++) connect(railMap, { x, z: 1 }, { x: x + 1, z: 1 });
  for (let x = 5; x < 9; x++) connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
  for (let x = 5; x < 9; x++) connect(railMap, { x, z: 1 }, { x: x + 1, z: 1 });
  connect(railMap, { x: 6, z: 0 }, { x: 6, z: 1 }); // クロスオーバー: 2つの区間を1ブロックに

  const sig0Key = toKey(5, 0);
  railMap.set(sig0Key, { ...railMap.get(sig0Key)!, signalDir: DIR.E, signalKind: kind });
  const sig1Key = toKey(5, 1);
  railMap.set(sig1Key, { ...railMap.get(sig1Key)!, signalDir: DIR.E, signalKind: kind });

  const w1Key = toKey(0, 0);
  railMap.set(w1Key, { ...railMap.get(w1Key)!, type: 'station', stationId: 'stW1' });
  const w2Key = toKey(0, 1);
  railMap.set(w2Key, { ...railMap.get(w2Key)!, type: 'station', stationId: 'stW2' });
  const p1Key = toKey(9, 0);
  railMap.set(p1Key, { ...railMap.get(p1Key)!, type: 'station', stationId: 'stP1' });
  const p2Key = toKey(9, 1);
  railMap.set(p2Key, { ...railMap.get(p2Key)!, type: 'station', stationId: 'stP2' });

  const stations = new Map<string, StationData>([
    ['stW1', { id: 'stW1', name: 'W1', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
    ['stW2', { id: 'stW2', name: 'W2', cells: [{ x: 0, z: 1 }], center: { x: 0, z: 1 }, platformDoors: 'none' }],
    ['stP1', { id: 'stP1', name: 'P1', cells: [{ x: 9, z: 0 }], center: { x: 9, z: 0 }, platformDoors: 'none' }],
    ['stP2', { id: 'stP2', name: 'P2', cells: [{ x: 9, z: 1 }], center: { x: 9, z: 1 }, platformDoors: 'none' }],
  ]);

  return { railMap, stations };
};

describe('S2信号の種別', () => {
  it('場内信号(home)経由なら、同じブロックでも別のプラットフォーム track へ2列車が同時進入できる', () => {
    const { railMap, stations } = buildStationLayout('home');
    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stP1'], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 0, z: 1, schedule: ['stP2'], scheduleIndex: 0 });
    const world: SimWorld = {
      railMap, stations, trains: [trainA, trainB], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], rules: s2Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    let bothInsidePlatformBlock = false;
    for (let tick = 0; tick < 2000; tick++) {
      stepWorld(world, dt);
      const rtA = world.runtimes.get('A');
      const rtB = world.runtimes.get('B');
      const aInside = !!rtA && rtA.trail.some(c => c.x >= 6 && c.x <= 9);
      const bInside = !!rtB && rtB.trail.some(c => c.x >= 6 && c.x <= 9);
      if (aInside && bInside) bothInsidePlatformBlock = true;
    }
    expect(bothInsidePlatformBlock).toBe(true);
  });

  it('種別無し(kind未設定)の信号は閉塞信号として振る舞い、ブロック全体が占有中は他列車が入れない', () => {
    const { railMap, stations } = buildStationLayout(undefined);
    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stP1'], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 0, z: 1, schedule: ['stP2'], scheduleIndex: 0 });
    const world: SimWorld = {
      railMap, stations, trains: [trainA, trainB], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], rules: s2Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    let bothInsidePlatformBlock = false;
    for (let tick = 0; tick < 2000; tick++) {
      stepWorld(world, dt);
      const rtA = world.runtimes.get('A');
      const rtB = world.runtimes.get('B');
      const aInside = !!rtA && rtA.trail.some(c => c.x >= 6 && c.x <= 9);
      const bInside = !!rtB && rtB.trail.some(c => c.x >= 6 && c.x <= 9);
      if (aInside && bInside) bothInsidePlatformBlock = true;
    }
    expect(bothInsidePlatformBlock).toBe(false);
  });

  it('S1配下ではsignalKind=homeが付いていても無視され、従来どおりブロック全体で排他される', () => {
    const { railMap, stations } = buildStationLayout('home');
    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stP1'], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 0, z: 1, schedule: ['stP2'], scheduleIndex: 0 });
    const world: SimWorld = {
      railMap, stations, trains: [trainA, trainB], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], rules: s1Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    let bothInsidePlatformBlock = false;
    for (let tick = 0; tick < 2000; tick++) {
      stepWorld(world, dt);
      const rtA = world.runtimes.get('A');
      const rtB = world.runtimes.get('B');
      const aInside = !!rtA && rtA.trail.some(c => c.x >= 6 && c.x <= 9);
      const bInside = !!rtB && rtB.trail.some(c => c.x >= 6 && c.x <= 9);
      if (aInside && bInside) bothInsidePlatformBlock = true;
    }
    expect(bothInsidePlatformBlock).toBe(false);
  });

  it('同じプラットフォームtrackを目指す2列車は、home信号越しでも後発がセル排他で待つ', () => {
    const { railMap, stations } = buildStationLayout('home');
    // 進入線をさらに手前へ延ばし、Cを後方(x=-3)から発車させて先着列車Aと重ならない
    // 開始位置にする。どちらもstP1(platform1)を目指す。
    for (let x = -3; x < 0; x++) connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stP1', 'stW1'], scheduleIndex: 0 });
    const trainC = makeTrain({ id: 'C', x: -3, z: 0, schedule: ['stP1', 'stW1'], scheduleIndex: 0 });
    const world: SimWorld = {
      railMap, stations, trains: [trainA, trainC], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], rules: s2Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    for (let tick = 0; tick < 2000; tick++) {
      stepWorld(world, dt);
      const rtA = world.runtimes.get('A');
      const rtC = world.runtimes.get('C');
      if (rtA && rtC) {
        const setA = new Set(rtA.trail.map(c => toKey(c.x, c.z)));
        for (const c of rtC.trail) {
          expect(setA.has(toKey(c.x, c.z))).toBe(false);
        }
      }
    }
  });

  it('出発信号越しの延長は、停車中は行わず、発車後も先の区間が空くまで待ち、空けば進める', () => {
    // stP1の先に出発信号(10,0)、その先に単線のstFar(13,0)を置く。stFarをghost予約で
    // 塞いでいる間、Aはstart P1で停車を終えても出発信号の先へ予約を延長できず待つ。
    // ghost予約を外すと、出発信号越しの区間へ進めるようになることを確認する。
    const railMap = new Map<string, CellData>();
    for (let x = 0; x < 9; x++) connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    for (let x = 10; x < 13; x++) connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    connect(railMap, { x: 9, z: 0 }, { x: 10, z: 0 });

    const wKey = toKey(0, 0);
    railMap.set(wKey, { ...railMap.get(wKey)!, type: 'station', stationId: 'stW1' });
    const p1Key = toKey(9, 0);
    railMap.set(p1Key, { ...railMap.get(p1Key)!, type: 'station', stationId: 'stP1' });
    const farKey = toKey(13, 0);
    railMap.set(farKey, { ...railMap.get(farKey)!, type: 'station', stationId: 'stFar' });

    const depSigKey = toKey(10, 0);
    railMap.set(depSigKey, { ...railMap.get(depSigKey)!, signalDir: DIR.E, signalKind: 'departure' });

    const stations = new Map<string, StationData>([
      ['stW1', { id: 'stW1', name: 'W1', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stP1', { id: 'stP1', name: 'P1', cells: [{ x: 9, z: 0 }], center: { x: 9, z: 0 }, platformDoors: 'none' }],
      ['stFar', { id: 'stFar', name: 'Far', cells: [{ x: 13, z: 0 }], center: { x: 13, z: 0 }, platformDoors: 'none' }],
    ]);

    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stP1', 'stFar'], scheduleIndex: 0 });
    const world: SimWorld = {
      railMap, stations, trains: [trainA], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], rules: s2Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    let arrivedAtP1 = false;
    let observedHeldAtPlatform = false;
    let aEnteredFarBlockWhileGhostHeld = false;
    let ghostReleased = false;
    for (let tick = 0; tick < 4000; tick++) {
      const events: SimEvent[] = stepWorld(world, dt);
      const rtA = world.runtimes.get('A');
      for (const e of events) {
        if (e.type === 'arrive' && e.trainId === 'A') {
          trainA.scheduleIndex = (trainA.scheduleIndex + 1) % trainA.schedule.length;
          if (rtA?.lastStopStationId === 'stP1' && !arrivedAtP1) {
            arrivedAtP1 = true;
            // AがstP1に到着した直後は、停車中は経路もreservedEndIndexも持たない
            // (=出発信号の先を停車中に予約しない)。ここでghost予約を入れ、出発信号の
            // 先(stFar側)を塞いだ状態を作る。
            world.reservations!.set(reservationKey({ x: 13, z: 0 }), 'ghost');
            expect(rtA.route.length).toBe(0);
            expect(rtA.reservedEndIndex).toBe(-1);
          }
        }
      }
      if (arrivedAtP1 && !ghostReleased) {
        if (rtA && rtA.lastStopStationId === 'stP1' && rtA.route.length > 0 && rtA.reservedEndIndex < 0) {
          observedHeldAtPlatform = true;
        }
        if (rtA && rtA.trail.some(c => c.x >= 10 && c.x <= 13)) {
          aEnteredFarBlockWhileGhostHeld = true;
        }
        // 十分待ったところでghost予約を外し、以後は進めることを確認する。
        if (observedHeldAtPlatform && tick > 0 && tick % 500 === 0) {
          world.reservations!.delete(reservationKey({ x: 13, z: 0 }));
          ghostReleased = true;
        }
      }
    }
    expect(observedHeldAtPlatform).toBe(true);
    expect(aEnteredFarBlockWhileGhostHeld).toBe(false);
    const rtA = world.runtimes.get('A')!;
    expect(rtA.trail.some(c => c.x >= 10)).toBe(true);
  });
});
