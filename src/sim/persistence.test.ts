import { describe, it, expect } from 'vitest';
import type { CellData, StationData, TrainData, TownData } from '../types';
import type { TrainRuntime } from './simulation';
import { serialiseWorld, deserialiseWorld, emptyLedger } from './persistence';
import { STARTING_MONEY, type MonthlyLedger } from './economy';
import type { PassengerCohort } from './passengers';
import type { CornerDiffs } from './terrainOverlay';

describe('persistence: serialiseWorld / deserialiseWorld のラウンドトリップ (v15)', () => {
  it('railMap/stations/trains/runtimes/waiting/money/towns/seed/halfExtent/cornerDiffs/clock/台帳/stopLocation/運用グループ/借入残高/行き先つき待ち客 が JSON 経由でも復元できる', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: 3 }],
      ['1,0', { type: 'station', connections: 15, stationId: 'stA' }],
      // P7b: tunnelはboolean→{height:number}に拡張された。JSON経由でも
      // 高さが失われず往復することを確認する。
      ['2,0', { type: 'rail', connections: 3, tunnel: { height: 2 } }],
    ]);
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'Station A', cells: [{ x: 1, z: 0, layer: 0 }], center: { x: 1, z: 0 }, platformDoors: 'none' }],
    ]);
    const trains: TrainData[] = [
      { id: 't1', x: 0, z: 0, schedule: ['stA'], scheduleIndex: 0, status: 'running', cars: 2 },
    ];
    const runtimes = new Map<string, TrainRuntime>([
      ['t1', {
        id: 't1',
        grid: { x: 0, z: 0 },
        prevGrid: null,
        progress: 0.5,
        speedKmh: 42,
        route: [{ x: 1, z: 0 }],
        trail: [{ x: 0, z: 0 }], pathHistory: [{ x: 0, z: 0 }],
        stopRemaining: 0,
        waitTimer: 0,
        debugStatus: 'Accelerating',
        renderPos: { x: 0.5, y: 0.5, z: 0 },
        renderTarget: { x: 1, y: 0.5, z: 0 },
        passengers: 12,
        lastStopStationId: 'stA',
        haltRemaining: 0,
        reservedEndIndex: -1,
        load: [],
      }],
    ]);
    const waiting = new Map<string, number>([['stA', 34]]);
    const money = 42_300;
    const towns: TownData[] = [{ id: 'town-0', name: '試験町', centre: { x: 5, z: 5 }, population: 2500 }];
    const seed = 123456;
    const halfExtent = 45;
    const cornerDiffs: CornerDiffs = new Map([['0,0', new Map([[5, 3]])]]);
    const clock = { elapsed: 1234 };
    const currentLedger: MonthlyLedger = { year: 1, month: 5, fares: 1000, construction: 2000, upkeep: 0, accidents: 0, interest: 0 };
    const ledgerHistory: MonthlyLedger[] = [
      { year: 1, month: 4, fares: 900, construction: 0, upkeep: 300, accidents: 5000, interest: 417 },
    ];

    const groups = [
      { id: 'g1', name: '1系統', schedule: ['stA', 'stB'], headwaySeconds: 45, colour: '#1f8fd6' },
    ];
    const groupDepartures = new Map<string, number>([['g1|stA', 987]]);
    const demand = new Map<string, PassengerCohort[]>([['stA', [{ destinationId: 'stB', count: 12.5 }]]]);

    const saveData = serialiseWorld(
      railMap, stations, trains, runtimes, waiting, money, towns, seed,
      clock, currentLedger, ledgerHistory, 'far', groups, groupDepartures, 60_000, demand,
      halfExtent, cornerDiffs
    );
    expect(saveData.version).toBe(15);

    const json = JSON.stringify(saveData);
    const parsed = JSON.parse(json);
    const restored = deserialiseWorld(parsed);
    expect(restored).not.toBeNull();

    expect(restored!.railMap).toEqual(railMap);
    expect(restored!.clock).toEqual(clock);
    expect(restored!.currentLedger).toEqual(currentLedger);
    expect(restored!.ledgerHistory).toEqual(ledgerHistory);
    expect(restored!.stations).toEqual(stations);
    expect(restored!.trains).toEqual(trains);
    expect(restored!.runtimes).toEqual(runtimes);
    expect(restored!.waiting).toEqual(waiting);
    expect(restored!.money).toBe(money);
    expect(restored!.towns).toEqual(towns);
    expect(restored!.seed).toBe(seed);
    expect(restored!.halfExtent).toBe(halfExtent);
    expect(restored!.cornerDiffs).toEqual(cornerDiffs);
    expect(restored!.stopLocation).toBe('far');
    expect(restored!.groups).toEqual(groups);
    expect(restored!.groupDepartures).toEqual(groupDepartures);
    expect(restored!.loan).toBe(60_000);
    expect(restored!.demand).toEqual(demand);
  });

  it('v11データ(駅セルにlayerが無い)を読み込むと、v15ではないためnullを返す(セーブ互換は破壊してよい)', () => {
    const v11 = {
      version: 11 as const,
      railMap: [],
      stations: [
        ['stA', { id: 'stA', name: 'A駅', cells: [{ x: 1, z: 0 }, { x: 2, z: 0 }], center: { x: 1.5, z: 0 }, platformDoors: 'none' as const }],
      ] as [string, StationData][],
      trains: [], runtimes: [], waiting: [],
      money: 1000, loan: 0, towns: [], terrain: [],
      clock: { elapsed: 0 },
      currentLedger: emptyLedger(),
      ledgerHistory: [],
      stopLocation: 'middle' as const,
      groups: [], groupDepartures: [],
      demand: [],
    };
    expect(deserialiseWorld(v11 as never)).toBeNull();
  });

  it('v14データ(terrain/heights形式)を読み込むと、v15ではないためnullを返す', () => {
    const v14Data = {
      version: 14,
      railMap: [], stations: [], trains: [], runtimes: [], waiting: [],
      money: 10_000, towns: [],
      terrain: [['0,0', 'mountain']],
      heights: [['0,0', 9]],
      clock: { elapsed: 0 },
      currentLedger: emptyLedger(),
      ledgerHistory: [],
      stopLocation: 'middle',
      groups: [], groupDepartures: [],
      loan: 0, demand: [],
    };
    expect(deserialiseWorld(v14Data as never)).toBeNull();
  });

  it('壊れた/古いバージョン番号のセーブを読み込むとnullを返す', () => {
    expect(deserialiseWorld({ version: 1 } as never)).toBeNull();
    expect(deserialiseWorld({ version: 999 } as never)).toBeNull();
  });

  it('STARTING_MONEYはv15と無関係に既存のフォールバックとして参照可能', () => {
    // v1系の移行チェーンは廃止したため、STARTING_MONEYは新規ゲームの初期値としてのみ使う。
    expect(STARTING_MONEY).toBeGreaterThan(0);
  });

  it('P8a: 地下(負レベル)のuppers/ramp.base/StationData.cells[].layerもv15のままJSON経由で往復する', () => {
    // design docの決定: CellData.uppersはPartial<Record<Level,...>>への型widening
    // (実体はキーが数値の素朴なオブジェクト)、ramp.baseは元からnumber型なので、
    // 地下(負レベル)の追加はランタイムの形を一切変えていない(TypeScriptの型だけの
    // 拡張)。よってv15のシリアライズ形式は無変更のまま追加互換になる、というのが
    // このタスクの結論。以下はそれを裏付けるラウンドトリップ確認。
    const railMap = new Map<string, CellData>([
      ['0,0', {
        type: 'rail',
        connections: 0,
        uppers: { [-1]: { connections: 3, stationId: 'stU' } },
        ramp: { dir: 1, level: 2, base: -1 },
      }],
    ]);
    const stations = new Map<string, StationData>([
      ['stU', { id: 'stU', name: '地下駅', cells: [{ x: 0, z: 0, layer: -1 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
    ]);

    const saveData = serialiseWorld(
      railMap, stations, [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map()
    );
    const restored = deserialiseWorld(JSON.parse(JSON.stringify(saveData)));
    expect(restored).not.toBeNull();
    const cell = restored!.railMap.get('0,0')!;
    expect(cell.uppers?.[-1]).toEqual({ connections: 3, stationId: 'stU' });
    expect(cell.ramp).toEqual({ dir: 1, level: 2, base: -1 });
    expect(restored!.stations.get('stU')!.cells).toEqual([{ x: 0, z: 0, layer: -1 }]);
  });
});
