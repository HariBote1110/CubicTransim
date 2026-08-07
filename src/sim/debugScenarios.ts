// デバッグシナリオ集。純粋関数のみ。React/THREE には依存しない。
//
// 起動ダイアログの「デバッグモード」から選ぶ、目視確認用の小さな自己完結の世界の
// カタログ。各シナリオは construction.ts の apply系関数で世界を組み立てる
// (createDebugScenario と同じ流儀)。セーブデータは使わず、その場で生成する。
import type { CellData, StationData, TerrainType, TownData, TrainData, TrainGroupData } from '../types';
import { DIR, toKey } from '../utils';
import {
  applyElevatedPath,
  applyRailPath,
  applyStation,
  type ConstructionState,
  type ElevatedLevel,
} from './construction';
import { createDebugScenario } from './debugScenario';
import type { TerrainField } from './terrainField';
import { fieldFromMaps } from './terrainField';
import { GROUP_COLOURS } from './groups';

/**
 * シナリオが構築する世界。旧 DebugScenario(railMap/stations/trains)の上位互換で、
 * 地形・標高・町・運用グループ・所持金の上書きを任意で持てる。
 * useGameLogic.loadDebugScenario はこの形をそのまま受け取って state に流し込む。
 */
export interface DebugScenarioWorld {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  trains: TrainData[];
  /** 手組みの地形field(terrainField.tsのfieldFromMapsでMapから橋渡し)。省略時は全域平地。 */
  field?: TerrainField;
  /** 通常の乱数地形を使いたい場合、worldSeedをこの値に差し替える(cornerDiffsはクリアされる)。 */
  worldSeedOverride?: number;
  towns?: TownData[];
  groups?: TrainGroupData[];
  /** 指定した場合のみ所持金を上書きする(未指定なら現在の所持金のまま)。 */
  money?: number;
}

export interface DebugScenarioDef {
  id: string;
  label: string;
  /** 一行説明(起動ダイアログのシナリオ一覧に表示)。 */
  description: string;
  build: () => DebugScenarioWorld;
}

const emptyState = (): ConstructionState => ({ railMap: new Map(), stations: new Map() });

const stationIdAt = (state: ConstructionState, x: number, z: number): string => {
  const id = state.railMap.get(toKey(x, z))?.stationId;
  if (!id) throw new Error(`デバッグシナリオの駅(${x},${z})を作成できませんでした`);
  return id;
};

const line = (from: { x: number; z: number }, to: { x: number; z: number }): { x: number; z: number }[] => {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.z - from.z));
  const sx = Math.sign(to.x - from.x);
  const sz = Math.sign(to.z - from.z);
  return Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + sx * i, z: from.z + sz * i }));
};

// --- 2. 多層高架と立体交差 -------------------------------------------------

// 地平の東西線の上を、Lv1〜Lv3の南北の高架線が跨ぐ。各高架線は両端が自動生成の
// 坂で地平の引き込み線に接続し、レベルごとに1編成が往復する。
function buildMultiLevelScenario(): DebugScenarioWorld {
  let state = emptyState();

  // 地平の東西線
  state = applyRailPath(state, line({ x: -8, z: 0 }, { x: 8, z: 0 }));
  state = applyStation(state, { x: -8, z: 0 }, undefined, [], 'ew');
  state = applyStation(state, { x: 8, z: 0 }, undefined, [], 'ew');

  const trains: TrainData[] = [
    {
      id: 'debug-ground',
      x: -6, z: 0,
      schedule: [stationIdAt(state, 8, 0), stationIdAt(state, -8, 0)],
      scheduleIndex: 0, status: 'running', cars: 2,
    },
  ];

  const columns: Array<{ x: number; level: ElevatedLevel }> = [
    { x: -4, level: 1 },
    { x: 0, level: 2 },
    { x: 4, level: 3 },
  ];
  for (const { x, level } of columns) {
    // 地平の引き込み線(南北の両側)→ 間を高架で結ぶと端が自動で坂になる
    state = applyRailPath(state, line({ x, z: -14 }, { x, z: -10 }));
    state = applyRailPath(state, line({ x, z: 10 }, { x, z: 14 }));
    state = applyElevatedPath(state, line({ x, z: -10 }, { x, z: 10 }), undefined, level);
    state = applyStation(state, { x, z: -14 }, undefined, [], 'ns');
    state = applyStation(state, { x, z: 14 }, undefined, [], 'ns');
    trains.push({
      id: `debug-level${level}`,
      x, z: -12,
      schedule: [stationIdAt(state, x, 14), stationIdAt(state, x, -14)],
      scheduleIndex: 0, status: 'running', cars: 2,
    });
  }

  return { railMap: state.railMap, stations: state.stations, trains };
}

// --- 3. 山岳トンネル -------------------------------------------------------

// 南北に走る尾根(最高3段)を東西線がトンネルで貫く。両側の坑口が山肌に見える。
function buildTunnelScenario(): DebugScenarioWorld {
  const terrain = new Map<string, TerrainType>();
  const heights = new Map<string, number>();
  // ピラミッド状の尾根: h = max(0, min(3-|x|, 7-|z|))。各項が1-Lipschitzなので
  // normaliseHeights相当の隣接段差1以下が保証される。
  for (let x = -3; x <= 3; x++) {
    for (let z = -7; z <= 7; z++) {
      const h = Math.max(0, Math.min(3 - Math.abs(x), 7 - Math.abs(z)));
      if (h >= 1) {
        heights.set(toKey(x, z), h);
        terrain.set(toKey(x, z), 'mountain');
      }
    }
  }
  const field = fieldFromMaps(heights, terrain, 45);

  let state = emptyState();
  state = applyRailPath(state, line({ x: -8, z: 0 }, { x: 8, z: 0 }), field);
  state = applyStation(state, { x: -8, z: 0 }, field, [], 'ew');
  state = applyStation(state, { x: 8, z: 0 }, field, [], 'ew');

  return {
    railMap: state.railMap,
    stations: state.stations,
    field,
    trains: [
      {
        id: 'debug-tunnel',
        x: -6, z: 0,
        schedule: [stationIdAt(state, 8, 0), stationIdAt(state, -8, 0)],
        scheduleIndex: 0, status: 'running', cars: 2,
      },
    ],
  };
}

// --- 4. 単線行き違い -------------------------------------------------------

// passing-loop.test.ts の受け入れシナリオと同じレイアウト:
// 駅W(0,0) - 単線 - 交換設備(本線10..15 / 待避線11..14,z=1) - 単線 - 駅E(25,0)。
// 信号3基((11,0)東向き・(14,1)西向き・(14,0)東向き)で対向2列車が自動ですれ違う。
function buildPassingLoopScenario(): DebugScenarioWorld {
  let state = emptyState();
  state = applyRailPath(state, line({ x: 0, z: 0 }, { x: 25, z: 0 }));
  state = applyRailPath(state, [
    { x: 10, z: 0 }, { x: 11, z: 1 }, { x: 12, z: 1 }, { x: 13, z: 1 }, { x: 14, z: 1 }, { x: 15, z: 0 },
  ]);
  state = applyStation(state, { x: 0, z: 0 }, undefined, [], 'ew');
  state = applyStation(state, { x: 25, z: 0 }, undefined, [], 'ew');

  // 信号の向きは決め打ちで設定する(applySignalの巡回APIより直接指定が明快)。
  const railMap = new Map(state.railMap);
  const setSignal = (x: number, z: number, dir: number) => {
    const key = toKey(x, z);
    const cell = railMap.get(key);
    if (!cell) throw new Error(`デバッグシナリオの信号(${x},${z})を設置できませんでした`);
    railMap.set(key, { ...cell, signalDir: dir });
  };
  setSignal(11, 0, DIR.E); // 本線は東行き専用
  setSignal(14, 1, DIR.W); // 待避線は西行き専用
  setSignal(14, 0, DIR.E); // 合流点(15,0)の手前を防護

  const west = stationIdAt(state, 0, 0);
  const east = stationIdAt(state, 25, 0);
  return {
    railMap,
    stations: state.stations,
    trains: [
      { id: 'debug-eastbound', x: 0, z: 0, schedule: [east, west], scheduleIndex: 0, status: 'running', cars: 2 },
      { id: 'debug-westbound', x: 25, z: 0, schedule: [west, east], scheduleIndex: 0, status: 'running', cars: 2 },
    ],
  };
}

// --- 5. 分岐と運用グループ -------------------------------------------------

// 幹線の東端で分岐し、直進の本線(z=0)と斜めに逸れる支線(z=2)へ分かれる。
// 本線側の列車は運用グループ(共有運行表・折返し)に所属し、分岐器を通って走る。
// 支線側は単独運用の列車が支線内で往復する(単線の幹線での競合を避ける)。
function buildJunctionScenario(): DebugScenarioWorld {
  let state = emptyState();
  state = applyRailPath(state, line({ x: -8, z: 0 }, { x: 0, z: 0 })); // 幹線
  state = applyRailPath(state, line({ x: 0, z: 0 }, { x: 10, z: 0 })); // 本線(直進)
  state = applyRailPath(state, [
    { x: 0, z: 0 }, { x: 1, z: 1 }, { x: 2, z: 2 },
    ...line({ x: 3, z: 2 }, { x: 10, z: 2 }),
  ]); // 支線(分岐)

  state = applyStation(state, { x: -7, z: 0 }, undefined, [], 'ew'); // 幹線の起点駅
  state = applyStation(state, { x: 5, z: 0 }, undefined, [], 'ew');  // 本線1
  state = applyStation(state, { x: 10, z: 0 }, undefined, [], 'ew'); // 本線2
  state = applyStation(state, { x: 5, z: 2 }, undefined, [], 'ew');  // 支線1
  state = applyStation(state, { x: 10, z: 2 }, undefined, [], 'ew'); // 支線2

  const west = stationIdAt(state, -7, 0);
  const mainSchedule = [west, stationIdAt(state, 5, 0), stationIdAt(state, 10, 0)];
  const branchSchedule = [stationIdAt(state, 5, 2), stationIdAt(state, 10, 2)];

  const group: TrainGroupData = {
    id: 'debug-group-main',
    name: '本線系統',
    schedule: mainSchedule,
    headwaySeconds: 0,
    colour: GROUP_COLOURS[0],
    mode: 'shuttle',
  };

  return {
    railMap: state.railMap,
    stations: state.stations,
    groups: [group],
    trains: [
      {
        id: 'debug-main', x: -4, z: 0,
        schedule: mainSchedule, scheduleIndex: 0, status: 'running', cars: 2,
        groupId: group.id,
      },
      {
        id: 'debug-branch', x: 7, z: 2,
        schedule: branchSchedule, scheduleIndex: 0, status: 'running', cars: 2,
      },
    ],
  };
}

// --- 6. 大都市と踏切 -------------------------------------------------------

// 人口上限(50000人)の大都市の市街地を、地平の東西線が縁を貫く。市街地の道路が
// 線路と交わるタイルは踏切になる。町の成長スケール(Feature: 半径16タイル)の
// 目視確認も兼ねる。
function buildMetropolisScenario(): DebugScenarioWorld {
  let state = emptyState();
  state = applyRailPath(state, line({ x: -24, z: 8 }, { x: 24, z: 8 }));
  state = applyStation(state, { x: -24, z: 8 }, undefined, [], 'ew');
  state = applyStation(state, { x: 24, z: 8 }, undefined, [], 'ew');

  return {
    railMap: state.railMap,
    stations: state.stations,
    towns: [
      { id: 'debug-town-metro', name: '大都会市', centre: { x: 0, z: 0 }, population: 50_000 },
    ],
    trains: [
      {
        id: 'debug-metro', x: -20, z: 8,
        schedule: [stationIdAt(state, 24, 8), stationIdAt(state, -24, 8)],
        scheduleIndex: 0, status: 'running', cars: 3,
      },
    ],
  };
}

// --- 7. 地形編集の遊び場 ---------------------------------------------------

// 通常マップと同じ生成器(固定シード)で起伏のある地形だけを用意する。線路・町は
// 無し、所持金は最大にして、盛土/切土ツールを気兼ねなく試せるようにする。
function buildTerrainPlaygroundScenario(): DebugScenarioWorld {
  return {
    railMap: new Map(),
    stations: new Map(),
    trains: [],
    worldSeedOverride: 20260802,
    towns: [],
    money: 999_999_999,
  };
}

export const DEBUG_SCENARIOS: DebugScenarioDef[] = [
  {
    id: 'slopes-elevated-shuttle',
    label: '坂・高架・往復列車',
    description: '地平・坂・高架を1編成が往復する基本シナリオ',
    build: createDebugScenario,
  },
  {
    id: 'multi-level-crossing',
    label: '多層高架と立体交差',
    description: 'Lv1〜Lv3の高架線が地平線の上を跨ぎ、各レベルを1編成ずつ走る',
    build: buildMultiLevelScenario,
  },
  {
    id: 'mountain-tunnel',
    label: '山岳トンネル',
    description: '尾根をトンネルで貫く東西線。両側の坑口と1編成の走行を確認',
    build: buildTunnelScenario,
  },
  {
    id: 'passing-loop',
    label: '単線行き違い',
    description: '交換設備と信号3基で対向2列車が自動ですれ違う',
    build: buildPassingLoopScenario,
  },
  {
    id: 'junction-groups',
    label: '分岐と運用グループ',
    description: '分岐器で本線と支線に分かれ、本線列車は運用グループで折返し運転',
    build: buildJunctionScenario,
  },
  {
    id: 'metropolis-crossings',
    label: '大都市と踏切',
    description: '人口50000の大都市の縁を線路が貫き、市街地の道路が踏切になる',
    build: buildMetropolisScenario,
  },
  {
    id: 'terrain-playground',
    label: '地形編集の遊び場',
    description: '起伏のある地形と最大所持金のみ。盛土/切土ツールの試し場',
    build: buildTerrainPlaygroundScenario,
  },
];
