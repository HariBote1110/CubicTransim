import { describe, expect, it } from 'vitest';
import { computeStationArrivals } from './arrivals';
import type { TrainRuntime } from './simulation';
import type { TrainData, LineData, ServiceData } from '../types';

// 最小限のTrainRuntimeを作るヘルパー。テストで使わないフィールドはダミー値で埋める。
const makeRuntime = (overrides: Partial<TrainRuntime> & { id: string }): TrainRuntime => ({
  grid: { x: 0, z: 0 },
  prevGrid: null,
  progress: 0,
  speedKmh: 0,
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

const makeTrain = (overrides: Partial<TrainData> & { id: string }): TrainData => ({
  x: 0,
  z: 0,
  schedule: [],
  scheduleIndex: 0,
  status: 'running',
  cars: 2,
  ...overrides,
});

describe('computeStationArrivals', () => {
  it('この駅を目的地にしている列車だけを並べる', () => {
    const trains: TrainData[] = [
      makeTrain({ id: 't1', schedule: ['A', 'B'], scheduleIndex: 0 }), // Aへ向かう
      makeTrain({ id: 't2', schedule: ['B', 'A'], scheduleIndex: 0 }), // Bへ向かう(対象外)
      makeTrain({ id: 't3', schedule: ['A', 'B'], scheduleIndex: 0, status: 'stored' }), // 車庫待機(対象外)
    ];
    const runtimes = new Map<string, TrainRuntime>([
      ['t1', makeRuntime({ id: 't1', route: [{ x: 1, z: 0 }], speedKmh: 50 })],
      ['t2', makeRuntime({ id: 't2', route: [{ x: 1, z: 0 }], speedKmh: 50 })],
      ['t3', makeRuntime({ id: 't3' })],
    ]);

    const result = computeStationArrivals('A', trains, runtimes, [], []);

    expect(result.map(r => r.trainId)).toEqual(['t1']);
  });

  it('到着が早い順に並ぶ', () => {
    const trains: TrainData[] = [
      makeTrain({ id: 'near', schedule: ['A'], scheduleIndex: 0 }),
      makeTrain({ id: 'far', schedule: ['A'], scheduleIndex: 0 }),
    ];
    const runtimes = new Map<string, TrainRuntime>([
      ['near', makeRuntime({ id: 'near', grid: { x: 0, z: 0 }, route: [{ x: 1, z: 0 }], speedKmh: 60 })],
      ['far', makeRuntime({ id: 'far', grid: { x: 0, z: 0 }, route: [{ x: 10, z: 0 }], speedKmh: 60 })],
    ]);

    const result = computeStationArrivals('A', trains, runtimes, [], []);

    expect(result.map(r => r.trainId)).toEqual(['near', 'far']);
  });

  it('停車中の列車は到着0秒で先頭に出る', () => {
    const trains: TrainData[] = [
      makeTrain({ id: 'moving', schedule: ['A'], scheduleIndex: 0 }),
      makeTrain({ id: 'stopped', schedule: ['A'], scheduleIndex: 0 }),
    ];
    const runtimes = new Map<string, TrainRuntime>([
      ['moving', makeRuntime({ id: 'moving', route: [{ x: 1, z: 0 }], speedKmh: 60 })],
      ['stopped', makeRuntime({ id: 'stopped', route: [], stopRemaining: 2 })],
    ]);

    const result = computeStationArrivals('A', trains, runtimes, [], []);

    expect(result[0].trainId).toBe('stopped');
    expect(result[0].secondsUntilArrival).toBe(0);
    expect(result[0].isStopped).toBe(true);
  });

  it('速度0の列車でも秒数が無限大にならない(下限速度でクランプされる)', () => {
    const trains: TrainData[] = [makeTrain({ id: 't1', schedule: ['A'], scheduleIndex: 0 })];
    const runtimes = new Map<string, TrainRuntime>([
      ['t1', makeRuntime({ id: 't1', grid: { x: 0, z: 0 }, route: [{ x: 5, z: 0 }], speedKmh: 0 })],
    ]);

    const result = computeStationArrivals('A', trains, runtimes, [], []);

    expect(result[0].secondsUntilArrival).toBeGreaterThan(0);
    expect(Number.isFinite(result[0].secondsUntilArrival)).toBe(true);
  });

  it('行き先が路線の運行モード(環状/折返し)に従って決まる', () => {
    const loopLine: LineData = { id: 'l1', name: '1系統', stops: ['A', 'B', 'C'], colour: '#111', mode: 'loop' };
    const shuttleLine: LineData = { id: 'l2', name: '2系統', stops: ['A', 'B', 'C'], colour: '#222', mode: 'shuttle' };
    const loopService: ServiceData = { id: 's1', lineId: 'l1', name: '各停', skipStationIds: [], headwaySeconds: 0 };
    const shuttleService: ServiceData = { id: 's2', lineId: 'l2', name: '各停', skipStationIds: [], headwaySeconds: 0 };
    const trains: TrainData[] = [
      makeTrain({ id: 'loopTrain', serviceId: 's1', schedule: [], scheduleIndex: 0, scheduleDirection: 1 }),
      makeTrain({ id: 'shuttleTrain', serviceId: 's2', schedule: [], scheduleIndex: 0, scheduleDirection: 1 }),
    ];
    const runtimes = new Map<string, TrainRuntime>([
      ['loopTrain', makeRuntime({ id: 'loopTrain', route: [{ x: 1, z: 0 }], speedKmh: 50 })],
      ['shuttleTrain', makeRuntime({ id: 'shuttleTrain', route: [{ x: 1, z: 0 }], speedKmh: 50 })],
    ]);

    const result = computeStationArrivals(
      'A', trains, runtimes, [loopLine, shuttleLine], [loopService, shuttleService]
    );

    const loop = result.find(r => r.trainId === 'loopTrain');
    const shuttle = result.find(r => r.trainId === 'shuttleTrain');
    // 両者ともAが現在の目的駅(scheduleIndex=0)。次に停まる駅はどちらもBのはず
    // (環状: A→B→C→A、折返し: A→B→C→B→A のどちらもAの次はB)。
    expect(loop?.destinationStationId).toBe('B');
    expect(shuttle?.destinationStationId).toBe('B');
    expect(loop?.lineName).toBe('1系統');
    expect(shuttle?.lineName).toBe('2系統');
    expect(loop?.serviceName).toBe('各停');
  });

  it('路線に所属していない単独運用の列車も扱える', () => {
    const trains: TrainData[] = [
      makeTrain({ id: 'solo', schedule: ['A', 'B'], scheduleIndex: 0 }),
    ];
    const runtimes = new Map<string, TrainRuntime>([
      ['solo', makeRuntime({ id: 'solo', route: [{ x: 1, z: 0 }], speedKmh: 50 })],
    ]);

    const result = computeStationArrivals('A', trains, runtimes, [], []);

    expect(result).toHaveLength(1);
    expect(result[0].serviceId).toBeNull();
    expect(result[0].serviceName).toBeNull();
    expect(result[0].destinationStationId).toBe('B');
  });
});
