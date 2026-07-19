import type { CellData, StationData, TrainData, TownData, TerrainType } from '../types';
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

export type SaveData = SaveDataV1 | SaveDataV2 | SaveDataV3 | SaveDataV4 | SaveDataV5;

export function serialiseWorld(
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  trains: TrainData[],
  runtimes: Map<string, TrainRuntime>,
  waiting: Map<string, number>,
  money: number,
  towns: TownData[],
  terrain: Map<string, TerrainType>
): SaveDataV5 {
  return {
    version: 5,
    railMap: Array.from(railMap.entries()),
    stations: Array.from(stations.entries()),
    trains,
    runtimes: Array.from(runtimes.entries()),
    waiting: Array.from(waiting.entries()),
    money,
    towns,
    terrain: Array.from(terrain.entries()),
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

  if (data.version === 5) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: data.trains,
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
      towns: data.towns,
      terrain: new Map(data.terrain),
    };
  }

  if (data.version === 4) {
    return {
      railMap: new Map(data.railMap),
      stations: migrateStations(data.stations),
      trains: data.trains,
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
      towns: data.towns,
      // v4以前にはterrainが存在しないため、地形なし(全て平地)として移行する。
      terrain: new Map(),
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
      terrain: new Map(),
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
      terrain: new Map(),
    };
  }

  // v1→v5移行: waitingは空、moneyはSTARTING_MONEYから開始し、towns/terrainも空にする。
  return {
    railMap: new Map(data.railMap),
    stations: migrateStations(data.stations),
    trains: data.trains,
    runtimes,
    waiting: new Map(),
    money: STARTING_MONEY,
    towns: [],
    terrain: new Map(),
  };
}
