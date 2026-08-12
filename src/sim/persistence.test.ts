import { describe, it, expect } from 'vitest';
import type { CellData, StationData, TrainData, TownData } from '../types';
import type { TrainRuntime } from './simulation';
import { serialiseWorld, deserialiseWorld, emptyLedger, normaliseUndergroundRampDirs } from './persistence';
import { STARTING_MONEY, type MonthlyLedger } from './economy';
import type { PassengerCohort } from './passengers';
import type { CornerDiffs } from './terrainOverlay';
import { DEFAULT_GAME_RULES, PLAY_MODE_PRESETS } from './gameRules';
import { DIR } from '../utils';

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
    expect(saveData.version).toBe(18);

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

  it('townDensityがJSON経由で往復する', () => {
    const saveData = serialiseWorld(
      new Map(), new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map(), 'dense'
    );
    const restored = deserialiseWorld(JSON.parse(JSON.stringify(saveData)));
    expect(restored).not.toBeNull();
    expect(restored!.townDensity).toBe('dense');
  });

  it('townDensityを省略したセーブ(このセッション内のv15旧データ)を読み込むとnormalが既定になる', () => {
    const saveData = serialiseWorld(
      new Map(), new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map()
    );
    const raw = JSON.parse(JSON.stringify(saveData));
    delete raw.townDensity;
    const restored = deserialiseWorld(raw);
    expect(restored).not.toBeNull();
    expect(restored!.townDensity).toBe('normal');
  });

  it('terrainProfileがJSON経由で往復する', () => {
    const saveData = serialiseWorld(
      new Map(), new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map(), 'normal', 'mountain'
    );
    const restored = deserialiseWorld(JSON.parse(JSON.stringify(saveData)));
    expect(restored).not.toBeNull();
    expect(restored!.terrainProfile).toBe('mountain');
  });

  it('terrainProfileを省略したセーブ(v15)はnormal地形として読み込む', () => {
    const saveData = serialiseWorld(
      new Map(), new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map()
    );
    const raw = JSON.parse(JSON.stringify(saveData));
    delete raw.terrainProfile;
    raw.version = 15;
    const restored = deserialiseWorld(raw);
    expect(restored).not.toBeNull();
    expect(restored!.terrainProfile).toBe('normal');
  });

  it('rulesがJSON経由で往復する', () => {
    const saveData = serialiseWorld(
      new Map(), new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map(), 'normal', 'mountain', PLAY_MODE_PRESETS.normal
    );
    const restored = deserialiseWorld(JSON.parse(JSON.stringify(saveData)));
    expect(restored).not.toBeNull();
    expect(restored!.rules).toEqual(PLAY_MODE_PRESETS.normal);
  });

  it('rulesを省略したセーブ(v16以前)はDEFAULT_GAME_RULES(ライト相当)として読み込む', () => {
    const saveData = serialiseWorld(
      new Map(), new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map()
    );
    const raw = JSON.parse(JSON.stringify(saveData));
    delete raw.rules;
    raw.version = 16;
    const restored = deserialiseWorld(raw);
    expect(restored).not.toBeNull();
    expect(restored!.rules).toEqual(DEFAULT_GAME_RULES);
  });

});

describe('persistence: PM3 交直流電化(dc/ac)のラウンドトリップ', () => {
  it('railMapのelectrified: \'dc\'/\'ac\'がJSON経由で往復する', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: 1, electrified: 'dc' }],
      ['1,0', { type: 'rail', connections: 1, electrified: 'ac' }],
    ]);
    const saveData = serialiseWorld(
      railMap, new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map()
    );
    const restored = deserialiseWorld(JSON.parse(JSON.stringify(saveData)));
    expect(restored).not.toBeNull();
    expect(restored!.railMap.get('0,0')?.electrified).toBe('dc');
    expect(restored!.railMap.get('1,0')?.electrified).toBe('ac');
  });

  it('legacyのelectrified: true(PM2以前のセーブ)は\'dc\'として読み込む', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: 1, electrified: true }],
    ]);
    const saveData = serialiseWorld(
      railMap, new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map()
    );
    const restored = deserialiseWorld(JSON.parse(JSON.stringify(saveData)));
    expect(restored).not.toBeNull();
    expect(restored!.railMap.get('0,0')?.electrified).toBe('dc');
  });

  it('TrainDataのpower: \'electric-ac\'/\'electric-acdc\'がJSON経由で往復する', () => {
    const trains: TrainData[] = [
      { id: 'a', x: 0, z: 0, schedule: [], scheduleIndex: 0, status: 'stored', cars: 2, power: 'electric-ac' },
      { id: 'b', x: 1, z: 1, schedule: [], scheduleIndex: 0, status: 'stored', cars: 2, power: 'electric-acdc' },
    ];
    const saveData = serialiseWorld(
      new Map(), new Map(), trains, new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map()
    );
    const restored = deserialiseWorld(JSON.parse(JSON.stringify(saveData)));
    expect(restored).not.toBeNull();
    expect(restored!.trains.find(t => t.id === 'a')?.power).toBe('electric-ac');
    expect(restored!.trains.find(t => t.id === 'b')?.power).toBe('electric-acdc');
  });
});

describe('persistence: 軌道(何キロレール)のラウンドトリップ', () => {
  it('railMapのrailWeightとrules.trackClassesがJSON経由で往復する', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: 1, railWeight: 37 }],
      ['1,0', { type: 'rail', connections: 1, railWeight: 60 }],
    ]);
    const rules = { ...PLAY_MODE_PRESETS.realistic };
    const saveData = serialiseWorld(
      railMap, new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map(), 'normal', 'normal', rules
    );
    const restored = deserialiseWorld(JSON.parse(JSON.stringify(saveData)));
    expect(restored).not.toBeNull();
    expect(restored!.railMap.get('0,0')?.railWeight).toBe(37);
    expect(restored!.railMap.get('1,0')?.railWeight).toBe(60);
    expect(restored!.rules.trackClasses).toBe(true);
  });

  it('trackClassesが無い旧セーブはfalse(概念なし)として読み込む', () => {
    const saveData = serialiseWorld(
      new Map(), new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map(), 'normal', 'normal', DEFAULT_GAME_RULES
    );
    const raw = JSON.parse(JSON.stringify(saveData));
    delete (raw.rules as { trackClasses?: boolean }).trackClasses;
    const restored = deserialiseWorld(raw);
    expect(restored).not.toBeNull();
    expect(restored!.rules.trackClasses).toBe(false);
  });
});

describe('persistence: PM4 変電所(substation)のラウンドトリップ', () => {
  it('type: \'substation\'のセルはrailMapの他のセルと同じくJSON経由で往復する(専用フィールドは不要)', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: 1, electrified: 'dc' }],
      ['0,1', { type: 'substation' }],
    ]);
    const saveData = serialiseWorld(
      railMap, new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map()
    );
    const restored = deserialiseWorld(JSON.parse(JSON.stringify(saveData)));
    expect(restored).not.toBeNull();
    expect(restored!.railMap.get('0,1')?.type).toBe('substation');
  });
});

describe('persistence: normaliseUndergroundRampDirs (地下ランプdir逆転の旧セーブ移行)', () => {
  // base=-1の坂セル(0,0)。地表側(base+1===0)の隣接セルは(0,-1)=DIR.N方向で、
  // その隣接セルの平面connectionsに戻り方向(S)のビットが立っていれば「地表側へ連続している」。
  // 地下側の隣接セルは(0,1)=DIR.S方向で、uppers[-1].connectionsにN(戻り方向)ビットが
  // 立っていれば「地下側へ連続している」。正しいdirは地表側=北(DIR.N)を指す。
  const buildStructurallyCorrectMap = () => new Map<string, CellData>([
    ['0,-1', { type: 'rail', connections: DIR.S }],
    ['0,0', { type: 'rail', connections: 0, ramp: { dir: DIR.N, base: -1 } }],
    ['0,1', { type: 'rail', connections: 0, uppers: { [-1]: { connections: DIR.N } } }],
  ]);

  it('旧形式(dirが地下側=逆方向を指す)は正しい向き(地表側)へ修正される', () => {
    const railMap = buildStructurallyCorrectMap();
    // 旧バグ: dirを反転させて地下側(S)を指す不正な状態を人工的に作る
    railMap.set('0,0', { ...railMap.get('0,0')!, ramp: { dir: DIR.S, base: -1 } });
    const result = normaliseUndergroundRampDirs(railMap);
    expect(result.get('0,0')?.ramp?.dir).toBe(DIR.N);
  });

  it('新形式(dirが既に地表側を指す)はそのまま(参照レベルでも内容不変)', () => {
    const railMap = buildStructurallyCorrectMap();
    const before = railMap.get('0,0');
    const result = normaliseUndergroundRampDirs(railMap);
    expect(result.get('0,0')?.ramp?.dir).toBe(DIR.N);
    expect(result.get('0,0')).toEqual(before);
  });

  it('曖昧なケース(両側とも地表側らしく見える/どちらも見えない)は変更しない', () => {
    // 両隣接セルとも「地表側へ連続している」条件を満たす(北も南もconnections/upperで
    // 戻りビットが立っている)ため、構造的に判別不能。dirはそのまま残す。
    const railMap = new Map<string, CellData>([
      ['0,-1', { type: 'rail', connections: DIR.S }],
      ['0,0', { type: 'rail', connections: 0, ramp: { dir: DIR.S, base: -1 } }],
      // 地下側であるはずの(0,1)にも誤って地表相当のconnectionsを持たせ、両方が
      // 「地表側条件」を満たしてしまう曖昧ケースを作る。
      ['0,1', { type: 'rail', connections: DIR.N }],
    ]);
    const result = normaliseUndergroundRampDirs(railMap);
    expect(result.get('0,0')?.ramp?.dir).toBe(DIR.S);
  });

  it('rampを持たないセル・base>=0の坂セルには影響しない', () => {
    const railMap = new Map<string, CellData>([
      ['5,5', { type: 'rail', connections: DIR.N }],
      ['6,6', { type: 'rail', connections: 0, ramp: { dir: DIR.N, base: 1 } }],
    ]);
    const before5 = railMap.get('5,5');
    const before6 = railMap.get('6,6');
    const result = normaliseUndergroundRampDirs(railMap);
    expect(result.get('5,5')).toEqual(before5);
    expect(result.get('6,6')).toEqual(before6);
  });

  // M5: 正規化は「version<18の旧セーブだけ」に適用する。serialiseWorldは常に最新版数
  // (18)を書くため、旧形式(v17以前)のロードを確かめるにはversion:17の生データを
  // 直接組み立てる必要がある。
  it('version 17(<18)のセーブはロード時にrailMapへこの正規化を適用する', () => {
    const railMap = buildStructurallyCorrectMap();
    railMap.set('0,0', { ...railMap.get('0,0')!, ramp: { dir: DIR.S, base: -1 } });
    const saveData = { ...serialiseWorld(
      railMap, new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map()
    ), version: 17 as const };
    const restored = deserialiseWorld(JSON.parse(JSON.stringify(saveData)));
    expect(restored).not.toBeNull();
    expect(restored!.railMap.get('0,0')?.ramp?.dir).toBe(DIR.N);
  });

  // M5(progress/review-play-modes-branch.md): 正規化を版数で区切らないと、修正後に
  // 書かれた正しいセーブに対しても構造推定の誤判定でdirを反転しうる。v18(=serialiseWorld
  // が今書く版数)ではこのフィールドに触れないことを固定する。
  it('version 18のセーブは正規化を適用しない(新形式は既に正しいので触らない)', () => {
    const railMap = buildStructurallyCorrectMap();
    // v17形式なら反転対象になる不正な状態を人工的に作り、v18では「触らない」ことを見る。
    railMap.set('0,0', { ...railMap.get('0,0')!, ramp: { dir: DIR.S, base: -1 } });
    const saveData = serialiseWorld(
      railMap, new Map(), [], new Map(), new Map(), 1000, [], 1,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], new Map(), 0, new Map(),
      45, new Map()
    );
    expect(saveData.version).toBe(18);
    const restored = deserialiseWorld(JSON.parse(JSON.stringify(saveData)));
    expect(restored).not.toBeNull();
    expect(restored!.railMap.get('0,0')?.ramp?.dir).toBe(DIR.S);
  });
});
