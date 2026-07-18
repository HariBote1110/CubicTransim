import type { CellData, StationData, TrainData } from '../types';
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

export type SaveData = SaveDataV1 | SaveDataV2 | SaveDataV3;

export function serialiseWorld(
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  trains: TrainData[],
  runtimes: Map<string, TrainRuntime>,
  waiting: Map<string, number>,
  money: number
): SaveDataV3 {
  return {
    version: 3,
    railMap: Array.from(railMap.entries()),
    stations: Array.from(stations.entries()),
    trains,
    runtimes: Array.from(runtimes.entries()),
    waiting: Array.from(waiting.entries()),
    money,
  };
}

export function deserialiseWorld(data: SaveData): {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  trains: TrainData[];
  runtimes: Map<string, TrainRuntime>;
  waiting: Map<string, number>;
  money: number;
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

  if (data.version === 3) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: data.trains,
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
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
    };
  }

  // v1→v3移行: waitingは空、moneyはSTARTING_MONEYから開始する。
  return {
    railMap: new Map(data.railMap),
    stations: migrateStations(data.stations),
    trains: data.trains,
    runtimes,
    waiting: new Map(),
    money: STARTING_MONEY,
  };
}
