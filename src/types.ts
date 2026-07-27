import type { LineMode } from './sim/groups';
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
  // 注意: この`bridge`は「水上を渡る線路の見た目・コスト倍率」を表すフラグであり、
  // 立体交差(橋桁)を表す`upper`とは別物(紛らわしいが命名の経緯上そのまま)。
  bridge?: boolean;
  tunnel?: boolean;
  /**
   * 立体交差(橋桁)の高架側の線路。地平側(connections)とは接続しない別の線路。
   * construction.ts の applyBridge で橋の中間セル(橋桁)にのみ設定される
   * (直角に線路を敷いただけでは自動生成されない。平面交差にする場合は
   * connectionsへORするだけで済ませ、upperは作らない)。
   * 列車には層を持たせない。「そのセルにどちら向きで入ったか」(進入元へ戻るビットが
   * connectionsとupper.connectionsのどちらに立っているか)で一意に決まるため。
   */
  upper?: { connections: number };
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
  // 折返し運転で運行表を辿る向き(1=順方向、-1=逆方向)。環状運転では常に1。
  // 旧セーブには存在しないため、読み出しは常に (scheduleDirection ?? 1) で行う。
  scheduleDirection?: 1 | -1;
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
  /**
   * 走らせ方。'loop'は環状運転(末尾の次は先頭)、'shuttle'は折返し運転(終端で向きを反転)。
   * 旧セーブには存在しないため、読み出しは常に (mode ?? 'loop') で行う。
   */
  mode?: LineMode;
}

export const RAIL_COLOUR = '#555555';
export const STATION_COLOUR = '#ffaa00';
export const DEPOT_COLOUR = '#225588';
export const SIGNAL_COLOUR = '#ff3333';
export const TRAIN_COLOUR = '#FFFFFF';
export const SELECTED_TRAIN_COLOUR = '#ff0055'; 
export const GROUND_COLOUR = '#e0e0e0';