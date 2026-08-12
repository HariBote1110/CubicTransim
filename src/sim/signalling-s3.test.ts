import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir, DIR } from '../utils';
import type { CellData, StationData, TrainData, TrainProtection } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld } from './simulation';
import { buildBlockIndex } from './blocks';
import { PLAY_MODE_PRESETS } from './gameRules';
import {
  weakerProtection, SPAD_CHANCE,
  costOfProtection, trainCostForProtected, TRAIN_COST,
} from './economy';

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

const s3Rules = { ...PLAY_MODE_PRESETS.light, signalling: 's3' as const };

// trainA(0,0)->stE(3,0)で先着・停止して居座る(scheduleが無いので発車しない)。
// trainB(10,0)はstWで待機し、stEを目指してsignal(4,0、block)を越えようとするが、
// trainAがブロック(4..10)を占有しているため信号手前で待つ。protectionByCellへ
// signal(4,0)の保安装置を渡すことで、weakerProtection/SPADの評価対象を作る。
const buildWaitingLayout = (opts: { trackProtection?: TrainProtection }) => {
  const railMap = new Map<string, CellData>();
  for (let x = 0; x < 10; x++) connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });

  const wKey = toKey(0, 0);
  railMap.set(wKey, { ...railMap.get(wKey)!, type: 'station', stationId: 'stW' });
  const eKey = toKey(10, 0);
  railMap.set(eKey, { ...railMap.get(eKey)!, type: 'station', stationId: 'stE' });
  const sigKey = toKey(4, 0);
  railMap.set(sigKey, {
    ...railMap.get(sigKey)!,
    signalDir: DIR.E,
    signalKind: 'block',
    ...(opts.trackProtection ? { protection: opts.trackProtection } : {}),
  });

  const stations = new Map<string, StationData>([
    ['stW', { id: 'stW', name: 'W', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
    ['stE', { id: 'stE', name: 'E', cells: [{ x: 10, z: 0 }], center: { x: 10, z: 0 }, platformDoors: 'none' }],
  ]);
  return { railMap, stations };
};

describe('S3保安装置: SPAD(信号冒進)判定', () => {
  it('地上・車上とも無防備(none)なら、停止信号への進入待ちで1回だけ判定し、当たれば事故になる', () => {
    const { railMap, stations } = buildWaitingLayout({});
    const trainA = makeTrain({ id: 'A', x: 6, z: 0, schedule: [], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 0, z: 0, schedule: ['stE'], scheduleIndex: 0 });
    let rngCalls = 0;
    const world: SimWorld = {
      railMap, stations, trains: [trainA, trainB], runtimes: new Map(), waiting: new Map(),
      rng: () => { rngCalls++; return 0; }, // 常に最小値=どんな確率でも当たる
      towns: [], rules: s3Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    let spadEvents = 0;
    for (let tick = 0; tick < 600; tick++) {
      const events = stepWorld(world, dt);
      spadEvents += events.filter(e => e.type === 'accident' && e.kind === 'spad').length;
    }

    // trainAが4..10のブロックを占有しつづける間、trainBは信号(4,0)の手前でずっと待つ。
    // SPADはそのapproachにつき1回だけ判定される(ラッチ)ので、rngが毎回0でも
    // イベントは1件だけになる。
    expect(spadEvents).toBe(1);
    const rtB = world.runtimes.get('B')!;
    expect(rtB.haltRemaining).toBeGreaterThan(0);
  });

  it('ATS-P同士(地上・車上とも)ならSPAD確率は0で、rngが常に最小値でも事故は起きない', () => {
    const { railMap, stations } = buildWaitingLayout({ trackProtection: 'ats-p' });
    const trainA = makeTrain({ id: 'A', x: 6, z: 0, schedule: [], scheduleIndex: 0 });
    const trainB = makeTrain({
      id: 'B', x: 0, z: 0, schedule: ['stE'], scheduleIndex: 0, protection: 'ats-p',
    });
    const world: SimWorld = {
      railMap, stations, trains: [trainA, trainB], runtimes: new Map(), waiting: new Map(),
      rng: () => 0,
      towns: [], rules: s3Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    let spadEvents = 0;
    for (let tick = 0; tick < 600; tick++) {
      const events = stepWorld(world, dt);
      spadEvents += events.filter(e => e.type === 'accident' && e.kind === 'spad').length;
    }
    expect(spadEvents).toBe(0);
  });

  it('弱い方(weaker-of)が有効になる: 地上ATC・車上無防備でも無防備扱いでSPADが起こりうる', () => {
    const { railMap, stations } = buildWaitingLayout({ trackProtection: 'atc' });
    const trainA = makeTrain({ id: 'A', x: 6, z: 0, schedule: [], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 0, z: 0, schedule: ['stE'], scheduleIndex: 0 }); // protection未設定
    const world: SimWorld = {
      railMap, stations, trains: [trainA, trainB], runtimes: new Map(), waiting: new Map(),
      rng: () => 0,
      towns: [], rules: s3Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    let spadEvents = 0;
    for (let tick = 0; tick < 600; tick++) {
      const events = stepWorld(world, dt);
      spadEvents += events.filter(e => e.type === 'accident' && e.kind === 'spad').length;
    }
    expect(spadEvents).toBe(1); // none側の確率(2%)がrng=0で必ず当たる
  });
});

describe('S3保安装置: weakerProtection純関数', () => {
  it('未設定はnone扱いで、rankが低い方を返す', () => {
    expect(weakerProtection(undefined, undefined)).toBe('none');
    expect(weakerProtection('ats-s', undefined)).toBe('none');
    expect(weakerProtection('cbtc', 'ats-s')).toBe('ats-s');
    // L5: ats-p/atcは同rank(SPAD_CHANCEが同じ0)なので、どちらのタイブレークでも挙動は
    // 変わらない。実装の具体的な戻り値を固定するのではなく、その性質(結果のSPAD_CHANCEが
    // 両者の最大値=0と一致する)を確かめる。
    const tieResult = weakerProtection('ats-p', 'atc');
    expect(SPAD_CHANCE[tieResult]).toBe(Math.max(SPAD_CHANCE['ats-p'], SPAD_CHANCE.atc));
  });

  it('SPAD_CHANCEはATS-Sのみ0より大きく1未満、ATS-P/ATC/CBTCは0', () => {
    expect(SPAD_CHANCE.none).toBeGreaterThan(SPAD_CHANCE['ats-s']);
    expect(SPAD_CHANCE['ats-s']).toBeGreaterThan(0);
    expect(SPAD_CHANCE['ats-p']).toBe(0);
    expect(SPAD_CHANCE.atc).toBe(0);
    expect(SPAD_CHANCE.cbtc).toBe(0);
  });
});

// 2列車が同じ「1ブロック(信号無し)」区間へ連続して進入できるかを見る、S1テストと同型のレイアウト。
// 途中に経由駅(stMid1/stMid2、行き先ではない)を挟むことで、findSafeSegmentEndが
// 予約を1回の巨大な区間ではなく複数のsafe segmentへ分割する(駅はブロックを分割しない、
// signalling-s1.test.mdの同型レイアウトと同じ設計)。これにより、blocksSegmentEntry
// (ブロック全体の占有可否)側の差だけを観測できる。
const buildSingleBlockLayout = (protection?: TrainProtection) => {
  const railMap = new Map<string, CellData>();
  for (let x = 0; x < 20; x++) {
    connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    if (protection) {
      const key = toKey(x, 0);
      railMap.set(key, { ...railMap.get(key)!, protection });
    }
  }
  if (protection) {
    const lastKey = toKey(20, 0);
    railMap.set(lastKey, { ...railMap.get(lastKey)!, protection });
  }
  const wKey = toKey(0, 0);
  railMap.set(wKey, { ...railMap.get(wKey)!, type: 'station', stationId: 'stW' });
  const mid1Key = toKey(5, 0);
  railMap.set(mid1Key, { ...railMap.get(mid1Key)!, type: 'station', stationId: 'stMid1' });
  const mid2Key = toKey(15, 0);
  railMap.set(mid2Key, { ...railMap.get(mid2Key)!, type: 'station', stationId: 'stMid2' });
  const eKey = toKey(20, 0);
  railMap.set(eKey, { ...railMap.get(eKey)!, type: 'station', stationId: 'stE' });
  const stations = new Map<string, StationData>([
    ['stW', { id: 'stW', name: 'W', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
    ['stMid1', { id: 'stMid1', name: 'Mid1', cells: [{ x: 5, z: 0 }], center: { x: 5, z: 0 }, platformDoors: 'none' }],
    ['stMid2', { id: 'stMid2', name: 'Mid2', cells: [{ x: 15, z: 0 }], center: { x: 15, z: 0 }, platformDoors: 'none' }],
    ['stE', { id: 'stE', name: 'E', cells: [{ x: 20, z: 0 }], center: { x: 20, z: 0 }, platformDoors: 'none' }],
  ]);
  return { railMap, stations };
};

describe('S3保安装置: CBTC移動閉塞(Effect B)', () => {
  it('全セル+両列車がCBTCなら、S1/S2のブロック全体判定をバイパスして2列車が同時にブロックへ入れる', () => {
    const { railMap, stations } = buildSingleBlockLayout('cbtc');
    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stE'], scheduleIndex: 0, protection: 'cbtc' });
    const trainB = makeTrain({ id: 'B', x: 20, z: 0, schedule: ['stW'], scheduleIndex: 0, protection: 'cbtc' });
    const world: SimWorld = {
      railMap, stations, trains: [trainA, trainB], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], rules: s3Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    let bothInsideAtSomeTick = false;
    for (let tick = 0; tick < 2000; tick++) {
      stepWorld(world, dt);
      const rtA = world.runtimes.get('A');
      const rtB = world.runtimes.get('B');
      const aInside = !!rtA && rtA.trail.some(c => c.x > 0 && c.x < 20);
      const bInside = !!rtB && rtB.trail.some(c => c.x > 0 && c.x < 20);
      if (aInside && bInside) bothInsideAtSomeTick = true;
    }
    expect(bothInsideAtSomeTick).toBe(true);
  });

  it('CBTC区間でなければ(無防備な線路)、S3でもS1/S2と同じくブロック全体で排他される', () => {
    const { railMap, stations } = buildSingleBlockLayout(undefined);
    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stE'], scheduleIndex: 0, protection: 'cbtc' });
    const trainB = makeTrain({ id: 'B', x: 20, z: 0, schedule: ['stW'], scheduleIndex: 0, protection: 'cbtc' });
    const world: SimWorld = {
      railMap, stations, trains: [trainA, trainB], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], rules: s3Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    let bothInsideAtSomeTick = false;
    for (let tick = 0; tick < 2000; tick++) {
      stepWorld(world, dt);
      const rtA = world.runtimes.get('A');
      const rtB = world.runtimes.get('B');
      const aInside = !!rtA && rtA.trail.some(c => c.x > 0 && c.x < 20);
      const bInside = !!rtB && rtB.trail.some(c => c.x > 0 && c.x < 20);
      if (aInside && bInside) bothInsideAtSomeTick = true;
    }
    expect(bothInsideAtSomeTick).toBe(false);
  });
});

describe('S3保安装置: コスト定数', () => {
  it('地上設備は保安装置ごとにセル単価が異なり、未指定はコストゼロ', () => {
    // L5: 単価定数を掛け算し直すのではなく、性質(未指定は0、セル数に比例、上位装置ほど
    // 高い)を確かめる。定数の値そのものを変えても、この性質が保たれていれば通る。
    expect(costOfProtection(3, undefined)).toBe(0);
    expect(costOfProtection(0, 'cbtc')).toBe(0);
    expect(costOfProtection(6, 'ats-s')).toBe(2 * costOfProtection(3, 'ats-s')); // セル数に比例
    expect(costOfProtection(3, 'ats-s')).toBeGreaterThan(0);
    expect(costOfProtection(3, 'ats-s')).toBeLessThan(costOfProtection(3, 'ats-p'));
    expect(costOfProtection(3, 'ats-p')).toBeLessThan(costOfProtection(3, 'atc'));
    expect(costOfProtection(3, 'atc')).toBeLessThan(costOfProtection(3, 'cbtc'));
  });

  it('車上装置は基準額に倍率を乗算合成する(電化倍率とは別建て)', () => {
    // L5: 倍率定数を掛け算し直すのではなく、性質(未指定は素の車両価格、上位装置ほど高い、
    // 電化倍率とは乗算で合成される)を確かめる。
    expect(trainCostForProtected('diesel', undefined)).toBe(TRAIN_COST);
    expect(trainCostForProtected('diesel', 'ats-s')).toBeGreaterThan(TRAIN_COST);
    expect(trainCostForProtected('diesel', 'ats-s')).toBeLessThan(trainCostForProtected('diesel', 'ats-p'));
    expect(trainCostForProtected('diesel', 'ats-p')).toBeLessThan(trainCostForProtected('diesel', 'atc'));
    expect(trainCostForProtected('diesel', 'atc')).toBeLessThan(trainCostForProtected('diesel', 'cbtc'));
    // 交流(AC_TRAIN_PRICE_MULTIPLIER)とCBTC倍率は乗算で合成される。
    const acCbtc = trainCostForProtected('electric-ac', 'cbtc');
    expect(acCbtc).toBeGreaterThan(trainCostForProtected('electric-ac', undefined));
    expect(acCbtc).toBeGreaterThan(trainCostForProtected('diesel', 'cbtc'));
  });
});
