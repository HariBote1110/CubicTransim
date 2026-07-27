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
  /** 町名(生成時に決まる。旧セーブには無いため移行処理で補う)。 */
  name: string;
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
  // 所属する運用グループのid。未所属(単独運用)はundefined。
  // グループに所属している間は schedule ではなくグループの運行表に従う。
  groupId?: string;
}

/**
 * 運用グループ(軽量なグループダイヤ)。
 * 運行表をグループで共有し、発車間隔を設定すると駅で自動的に等間隔運転になる。
 * 詳細は sim/groups.ts を参照。
 */
export interface TrainGroupData {
  id: string;
  name: string;
  /** グループで共有する停車駅の並び */
  schedule: string[];
  /** 発車間隔(シミュレーション秒)。0なら等間隔化しない */
  headwaySeconds: number;
  /** ラインカラー(車両の帯とUIのバッジに使う) */
  colour: string;
}

export const RAIL_COLOUR = '#555555';
export const STATION_COLOUR = '#ffaa00';
export const DEPOT_COLOUR = '#225588';
export const SIGNAL_COLOUR = '#ff3333';
export const TRAIN_COLOUR = '#FFFFFF';
export const SELECTED_TRAIN_COLOUR = '#ff0055'; 
export const GROUND_COLOUR = '#e0e0e0';