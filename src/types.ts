import * as THREE from 'three';

export type TrainType = 'commuter' | 'express';
export type CellType = 'rail' | 'station' | 'depot';

export interface CellData {
  type: CellType;
  connections?: number; 
  stationId?: string;
  rotation?: number;
  signalDir?: number;
}

export interface StationData {
  id: string;
  name: string;
  cells: { x: number, z: number }[];
  center: { x: number, z: number };
}

export interface TrainData {
  id: string;
  x: number;
  z: number;
  schedule: string[]; 
  scheduleIndex: number;
  status: 'stored' | 'running';
  // ★追加: この電車が確保している未来の経路（予約）
  reservedPath: { x: number, z: number }[];
}

export const RAIL_COLOUR = '#555555';
export const STATION_COLOUR = '#ffaa00';
export const DEPOT_COLOUR = '#225588';
export const SIGNAL_COLOUR = '#ff3333';
export const TRAIN_COLOUR = '#FFFFFF';
export const SELECTED_TRAIN_COLOUR = '#ff0055'; 
export const GROUND_COLOUR = '#e0e0e0';