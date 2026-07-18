import type { CellData, StationData, TrainData, TownData } from '../types';
import type { TrainRuntime } from './simulation';
import { STARTING_MONEY } from './economy';

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

export type SaveData = SaveDataV1 | SaveDataV2 | SaveDataV3 | SaveDataV4;

export function serialiseWorld(
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  trains: TrainData[],
  runtimes: Map<string, TrainRuntime>,
  waiting: Map<string, number>,
  money: number,
  towns: TownData[]
): SaveDataV4 {
  return {
    version: 4,
    railMap: Array.from(railMap.entries()),
    stations: Array.from(stations.entries()),
    trains,
    runtimes: Array.from(runtimes.entries()),
    waiting: Array.from(waiting.entries()),
    money,
    towns,
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
} {
  // v1データにはpassengers/lastStopStationIdが、v1/v2データにはhaltRemainingが
  // 存在しないため、既定値で補う。
  const runtimes = new Map(
    data.runtimes.map(([id, rt]) => [
      id,
      {
        ...rt,
        passengers: rt.passengers ?? 0,
        lastStopStationId: rt.lastStopStationId ?? null,
        haltRemaining: rt.haltRemaining ?? 0,
      },
    ])
  );

  // v1/v2データにはplatformDoorsが存在しないため、既定値'none'で補う。
  const migrateStations = (stations: [string, StationData][]) =>
    new Map(
      stations.map(([id, st]) => [id, { ...st, platformDoors: st.platformDoors ?? 'none' }])
    );

  if (data.version === 4) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: data.trains,
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
      towns: data.towns,
    };
  }

  if (data.version === 3) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: data.trains,
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
      // v3以前にはtownsが存在しないため、街なし(旅客需要0)で開始する。
      towns: [],
    };
  }

  if (data.version === 2) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: data.trains,
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
      towns: [],
    };
  }

  // v1→v4移行: waitingは空、moneyはSTARTING_MONEYから開始し、townsも空にする。
  return {
    railMap: new Map(data.railMap),
    stations: migrateStations(data.stations),
    trains: data.trains,
    runtimes,
    waiting: new Map(),
    money: STARTING_MONEY,
    towns: [],
  };
}
