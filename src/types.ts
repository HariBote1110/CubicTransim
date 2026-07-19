export type TrainType = 'commuter' | 'express';
export type CellType = 'rail' | 'station' | 'depot';

// 地形。平地は既定値のため Map には載せず、terrainAt() が 'grass' を返す。
export type TerrainType = 'water' | 'mountain';

export interface CellData {
  type: CellType;
  connections?: number;
  stationId?: string;
  rotation?: number;
  signalDir?: number;
  // ★追加: 水上の橋・山岳のトンネル(描画用のフラグ)。costOfPathの倍率とは別に、
  // applyRailPathがterrainを見て設定する。
  bridge?: boolean;
  tunnel?: boolean;
}

export type PlatformDoorType = 'none' | 'standard' | 'fullscreen';

export interface StationData {
  id: string;
  name: string;
  cells: { x: number, z: number }[];
  center: { x: number, z: number };
  platformDoors: PlatformDoorType;
}

export interface TownData {
  id: string;
  centre: { x: number, z: number };
  population: number;
}

export interface TrainData {
  id: string;
  x: number;
  z: number;
  schedule: string[];
  scheduleIndex: number;
  status: 'stored' | 'running';
  // 編成両数(1〜8)。旧セーブ(v6以前)には存在しないため、persistenceの移行処理でcars=2を補う。
  cars: number;
}

export const RAIL_COLOUR = '#555555';
export const STATION_COLOUR = '#ffaa00';
export const DEPOT_COLOUR = '#225588';
export const SIGNAL_COLOUR = '#ff3333';
export const TRAIN_COLOUR = '#FFFFFF';
export const SELECTED_TRAIN_COLOUR = '#ff0055'; 
export const GROUND_COLOUR = '#e0e0e0';