import type { CellData, StationData, TrainData } from '../types';
import type { TrainRuntime } from './simulation';

export interface SaveData {
  version: 1;
  railMap: [string, CellData][];
  stations: [string, StationData][];
  trains: TrainData[];
  runtimes: [string, TrainRuntime][];
}

export function serialiseWorld(
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  trains: TrainData[],
  runtimes: Map<string, TrainRuntime>
): SaveData {
  return {
    version: 1,
    railMap: Array.from(railMap.entries()),
    stations: Array.from(stations.entries()),
    trains,
    runtimes: Array.from(runtimes.entries()),
  };
}

export function deserialiseWorld(data: SaveData): {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  trains: TrainData[];
  runtimes: Map<string, TrainRuntime>;
} {
  return {
    railMap: new Map(data.railMap),
    stations: new Map(data.stations),
    trains: data.trains,
    runtimes: new Map(data.runtimes),
  };
}
