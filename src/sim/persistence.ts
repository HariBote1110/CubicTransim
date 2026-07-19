import type { CellData, StationData, TrainData, TownData, TerrainType } from '../types';
import type { TrainRuntime } from './simulation';
import { STARTING_MONEY, type MonthlyLedger } from './economy';

export interface SaveDataV1 {
  version: 1;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
}

export interface SaveDataV2 {
  version: 2;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
}

export interface SaveDataV3 {
  version: 3;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
}

export interface SaveDataV4 {
  version: 4;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
  towns: TownData[];
}

export interface SaveDataV5 {
  version: 5;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
  towns: TownData[];
  terrain: [string, TerrainType][];
}

export interface SaveDataV6 {
  version: 6;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
  towns: TownData[];
  terrain: [string, TerrainType][];
  clock: { elapsed: number };
  currentLedger: MonthlyLedger;
  ledgerHistory: MonthlyLedger[];
}

export interface SaveDataV7 {
  version: 7;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
  towns: TownData[];
  terrain: [string, TerrainType][];
  clock: { elapsed: number };
  currentLedger: MonthlyLedger;
  ledgerHistory: MonthlyLedger[];
}

export interface SaveDataV8 {
  version: 8;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
  waiting: [string, number][];
  money: number;
  towns: TownData[];
  terrain: [string, TerrainType][];
  clock: { elapsed: number };
  currentLedger: MonthlyLedger;
  ledgerHistory: MonthlyLedger[];
  stopLocation: 'near' | 'middle' | 'far';
}

export type SaveData = SaveDataV1 | SaveDataV2 | SaveDataV3 | SaveDataV4 | SaveDataV5 | SaveDataV6 | SaveDataV7 | SaveDataV8;

// 新規ゲーム開始時の空台帳(1年1月)。v5以前からの移行時にも使う。
export const emptyLedger = (): MonthlyLedger => ({ year: 1, month: 1, fares: 0, construction: 0, upkeep: 0, accidents: 0 });

export function serialiseWorld(
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  trains: TrainData[],
  runtimes: Map<string, TrainRuntime>,
  waiting: Map<string, number>,
  money: number,
  towns: TownData[],
  terrain: Map<string, TerrainType>,
  clock: { elapsed: number },
  currentLedger: MonthlyLedger,
  ledgerHistory: MonthlyLedger[],
  stopLocation: 'near' | 'middle' | 'far' = 'middle'
): SaveDataV8 {
  return {
    version: 8,
    railMap: Array.from(railMap.entries()),
    stations: Array.from(stations.entries()),
    trains,
    runtimes: Array.from(runtimes.entries()),
    waiting: Array.from(waiting.entries()),
    money,
    towns,
    terrain: Array.from(terrain.entries()),
    clock,
    currentLedger,
    ledgerHistory,
    stopLocation,
  };
}

export function deserialiseWorld(data: SaveData): {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  trains: TrainData[];
  runtimes: Map<string, TrainRuntime>;
  waiting: Map<string, number>;
  money: number;
  towns: TownData[];
  terrain: Map<string, TerrainType>;
  clock: { elapsed: number };
  currentLedger: MonthlyLedger;
  ledgerHistory: MonthlyLedger[];
  stopLocation: 'near' | 'middle' | 'far';
} {
  // v1データにはpassengers/lastStopStationIdが、v1/v2データにはhaltRemainingが、
  // v7以前のデータにはpathHistory(連結車両の滑らか描画用の走行履歴)が存在しないため、既定値で補う。
  const runtimes = new Map(
    data.runtimes.map(([id, rt]) => [
      id,
      {
        ...rt,
        passengers: rt.passengers ?? 0,
        lastStopStationId: rt.lastStopStationId ?? null,
        haltRemaining: rt.haltRemaining ?? 0,
        pathHistory: (rt as TrainRuntime).pathHistory ?? [...rt.trail],
        // 予約(PBS)状態はセーブに含めない。ロード後の最初のstepWorldで
        // ensureRuntime/ensureReservationが再構築する(-1=未取得の状態から再開)。
        reservedEndIndex: -1,
      },
    ])
  );

  // v1/v2データにはplatformDoorsが存在しないため、既定値'none'で補う。
  const migrateStations = (stations: [string, StationData][]) =>
    new Map(
      stations.map(([id, st]) => [id, { ...st, platformDoors: st.platformDoors ?? 'none' }])
    );

  // v6以前のデータにはtrains[].carsが存在しないため、既定値2(新造時の編成両数)で補う。
  const migrateTrains = (trains: TrainData[]) =>
    trains.map(t => ({ ...t, cars: t.cars ?? 2 }));

  if (data.version === 8) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: migrateTrains(data.trains),
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
      towns: data.towns,
      terrain: new Map(data.terrain),
      clock: data.clock,
      currentLedger: data.currentLedger,
      ledgerHistory: data.ledgerHistory,
      stopLocation: data.stopLocation,
    };
  }

  if (data.version === 7) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: migrateTrains(data.trains),
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
      towns: data.towns,
      terrain: new Map(data.terrain),
      clock: data.clock,
      currentLedger: data.currentLedger,
      ledgerHistory: data.ledgerHistory,
      // v7以前にはstopLocationが存在しないため、既定値'middle'(既存の編成中央基準)で移行する。
      stopLocation: 'middle',
    };
  }

  if (data.version === 6) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: migrateTrains(data.trains),
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
      towns: data.towns,
      terrain: new Map(data.terrain),
      clock: data.clock,
      currentLedger: data.currentLedger,
      ledgerHistory: data.ledgerHistory,
      stopLocation: 'middle',
    };
  }

  if (data.version === 5) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: migrateTrains(data.trains),
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
      towns: data.towns,
      terrain: new Map(data.terrain),
      // v5以前には暦・台帳が存在しないため、暦0(1年1月1日)・台帳空で移行する。
      clock: { elapsed: 0 },
      currentLedger: emptyLedger(),
      ledgerHistory: [],
      stopLocation: 'middle',
    };
  }

  if (data.version === 4) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: migrateTrains(data.trains),
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
      towns: data.towns,
      // v4以前にはterrainが存在しないため、地形なし(全て平地)として移行する。
      terrain: new Map(),
      clock: { elapsed: 0 },
      currentLedger: emptyLedger(),
      ledgerHistory: [],
      stopLocation: 'middle',
    };
  }

  if (data.version === 3) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: migrateTrains(data.trains),
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
      // v3以前にはtownsが存在しないため、街なし(旅客需要0)で開始する。
      towns: [],
      terrain: new Map(),
      clock: { elapsed: 0 },
      currentLedger: emptyLedger(),
      ledgerHistory: [],
      stopLocation: 'middle',
    };
  }

  if (data.version === 2) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: migrateTrains(data.trains),
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
      towns: [],
      terrain: new Map(),
      clock: { elapsed: 0 },
      currentLedger: emptyLedger(),
      ledgerHistory: [],
      stopLocation: 'middle',
    };
  }

  // v1→v6移行: waitingは空、moneyはSTARTING_MONEYから開始し、towns/terrain/暦/台帳も既定値にする。
  return {
    railMap: new Map(data.railMap),
    stations: migrateStations(data.stations),
    trains: migrateTrains(data.trains),
    runtimes,
    waiting: new Map(),
    money: STARTING_MONEY,
    clock: { elapsed: 0 },
    currentLedger: emptyLedger(),
    ledgerHistory: [],
    towns: [],
    terrain: new Map(),
    stopLocation: 'middle',
  };
}
