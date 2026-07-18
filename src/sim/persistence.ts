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

export type SaveData = SaveDataV1 | SaveDataV2;

export function serialiseWorld(
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  trains: TrainData[],
  runtimes: Map<string, TrainRuntime>,
  waiting: Map<string, number>,
  money: number
): SaveDataV2 {
  return {
    version: 2,
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
  // v1データにはpassengers/lastStopStationIdが存在しないため、既定値で補う。
  const runtimes = new Map(
    data.runtimes.map(([id, rt]) => [
      id,
      {
        ...rt,
        passengers: rt.passengers ?? 0,
        lastStopStationId: rt.lastStopStationId ?? null,
      },
    ])
  );

  if (data.version === 2) {
    return {
      railMap: new Map(data.railMap),
      stations: new Map(data.stations),
      trains: data.trains,
      runtimes,
      waiting: new Map(data.waiting),
      money: data.money,
    };
  }

  // v1→v2移行: waitingは空、moneyはSTARTING_MONEYから開始する。
  return {
    railMap: new Map(data.railMap),
    stations: new Map(data.stations),
    trains: data.trains,
    runtimes,
    waiting: new Map(),
    money: STARTING_MONEY,
  };
}
