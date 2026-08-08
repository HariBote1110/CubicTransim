// 立体交差の十字乗り換え駅の描画に必要な、地平/高架それぞれの駅セル集計。
//
// データモデル上は「upperを持ち、かつupper.stationIdがあるセル」が高架駅セルで、
// stationId無しのupperは単なる橋桁(駅ではない)。この判定はsim層(construction.ts等)
// と同じ定義を描画側でも使い回す(progress/cross-elevated-station-data-model.md参照)。
import type { CellData, Level, StationData } from '../types';
import { fromKey, toKey } from '../utils';
import type { TerrainField } from '../sim/terrainField';
import { OVERPASS_HEIGHT, MAX_ELEVATED_LEVEL } from '../sim/trackPath';
import { trackAngleFromConnections } from './stationGeometry';

const ELEVATED_LEVELS = Array.from({ length: MAX_ELEVATED_LEVEL }, (_, i) => (i + 1) as 1 | 2 | 3);
// P8b: 地下の駅ホーム集計用(-1〜-MAX_ELEVATED_LEVEL)。
const UNDERGROUND_LEVELS = ELEVATED_LEVELS.map(l => -l as -1 | -2 | -3);

export interface StationLayerCell {
  key: string;
  x: number;
  z: number;
  stationId: string;
  connections: number;
  /** このセルの立体交差駅ホームがあるレベル(正=高架、負=地下)。地平セルでは省略(=1相当)。 */
  level?: Level;
}

/** 指定レベルの立体交差駅セルかどうか(uppers[level]を持ち、かつstationIdがある)。 */
export const isElevatedStationCell = (cell: CellData | undefined, level: Level = 1): boolean =>
  !!cell?.uppers?.[level] && !!cell.uppers[level]!.stationId;

/** 地平の駅セル一覧(従来通りcell.type==='station')。 */
export function groundStationCells(railMap: Map<string, CellData>): StationLayerCell[] {
  const out: StationLayerCell[] = [];
  for (const [key, data] of railMap) {
    if (data.type !== 'station' || !data.stationId) continue;
    const { x, z } = fromKey(key);
    out.push({ key, x, z, stationId: data.stationId, connections: data.connections ?? 0, level: 1 });
  }
  return out;
}

/**
 * 高架の駅セル一覧(cell.uppers[L].stationIdがあるセルのみ、橋桁は含まない)。
 * レベル1〜MAX_ELEVATED_LEVELを全て走査するので、異なるレベルの高架駅が
 * 同一(x,z)に併存していても両方拾える(keyはレベルを含めて一意にする)。
 */
export function elevatedStationCells(railMap: Map<string, CellData>): StationLayerCell[] {
  return layeredStationCells(railMap, ELEVATED_LEVELS);
}

/**
 * 地下の駅セル一覧(cell.uppers[L].stationIdがあるセルのみ、L<0)。P8b。
 * elevatedStationCellsと同じ集計を負のレベルに対して行う。
 */
export function undergroundStationCells(railMap: Map<string, CellData>): StationLayerCell[] {
  return layeredStationCells(railMap, UNDERGROUND_LEVELS);
}

function layeredStationCells(railMap: Map<string, CellData>, levels: readonly Level[]): StationLayerCell[] {
  const out: StationLayerCell[] = [];
  for (const [key, data] of railMap) {
    for (const level of levels) {
      if (!isElevatedStationCell(data, level)) continue;
      const { x, z } = fromKey(key);
      const upper = data.uppers![level]!;
      out.push({ key: `${key}:L${level}`, x, z, stationId: upper.stationId!, connections: upper.connections, level });
    }
  }
  return out;
}

/**
 * 与えられた駅セル群のうち、同一stationIdの8近傍が1つ以下のセルを「端」とみなす
 * (上屋の妻側に柱を立てるかどうかの判定用)。地平・高架それぞれ別の層内だけで
 * 近傍を数える(層をまたいだ隣接は考慮しない)。
 */
export function computeStationEndKeys(cells: StationLayerCell[]): Set<string> {
  const byId = new Map<string, StationLayerCell[]>();
  for (const c of cells) {
    if (!byId.has(c.stationId)) byId.set(c.stationId, []);
    byId.get(c.stationId)!.push(c);
  }
  const ends = new Set<string>();
  for (const c of cells) {
    const siblings = byId.get(c.stationId) ?? [];
    let neighbours = 0;
    for (const s of siblings) {
      if (s.key === c.key) continue;
      if (Math.abs(s.x - c.x) <= 1 && Math.abs(s.z - c.z) <= 1) neighbours++;
    }
    if (neighbours <= 1) ends.add(c.key);
  }
  return ends;
}

/**
 * GameSceneの直交カメラ(position=[20,20,20]、原点注視)は視線方向が(-1,-1,-1)/√3の
 * 固定対角線になる。このため高さhにある点を画面上でクリックすると、地平面(y=0)への
 * レイキャストは実際には(x-h, z-h)の位置に命中する(導出はprogress参照)。
 * この関数は逆に、地平面クリック位置から「見えている高架セルの候補」を返す
 * (実際にその座標にupper.stationIdがあるかは呼び出し側でrailMapを見て確認すること)。
 * カメラ角度に依存する近似なので完全ではないが、実用上はこれで十分な精度になる。
 */
export interface StationHousePlacement {
  position: readonly [number, number, number];
  angle: number;
  labelY: number;
}

/**
 * 駅舎(1駅につき1つ)の配置(位置・向き・ラベルY)を求める。GameScene.tsxの
 * 駅舎JSXブロックから抽出した純粋関数(three.js/wgpu両方の駅舎描画が同じ配置を使う)。
 * 通常表示中に隠すべき完全地下駅(houseIsUnderground)はnullを返す。
 */
export function computeStationHousePlacement(
  station: StationData,
  railMap: Map<string, CellData>,
  field: TerrainField,
  undergroundView: boolean,
): StationHousePlacement | null {
  const ownGroundCells = station.cells.filter(c => !c.layer);
  const elevatedLevels = station.cells.map(c => c.layer).filter((l): l is Exclude<typeof l, 0 | undefined> => !!l);
  const hasElevatedCells = elevatedLevels.some(l => l > 0);
  const hasUndergroundCells = elevatedLevels.some(l => l < 0);
  const houseIsElevated = ownGroundCells.length === 0;
  const houseLevel = houseIsElevated
    ? (hasElevatedCells
      ? Math.min(...elevatedLevels.filter(l => l > 0))
      : Math.max(...elevatedLevels.filter(l => l < 0)))
    : 1;
  const cellsForHouse = houseIsElevated
    ? station.cells.filter(c => c.layer === houseLevel)
    : ownGroundCells;
  const centreCell = cellsForHouse[Math.floor(cellsForHouse.length / 2)] ?? station.center;
  const centreConnections = houseIsElevated
    ? railMap.get(toKey(centreCell.x, centreCell.z))?.uppers?.[houseLevel as Level]?.connections
    : railMap.get(toKey(centreCell.x, centreCell.z))?.connections;
  const angle = trackAngleFromConnections(centreConnections);
  const houseY = houseIsElevated
    ? houseLevel * OVERPASS_HEIGHT
    : field.cellHeightAt(centreCell.x, centreCell.z) * OVERPASS_HEIGHT;
  const labelY = hasElevatedCells
    ? 1.35 + Math.max(...elevatedLevels) * OVERPASS_HEIGHT
    : 1.35 + houseY;
  const houseIsUnderground = houseIsElevated && houseLevel < 0;
  if (houseIsUnderground && hasUndergroundCells && !ownGroundCells.length && !hasElevatedCells && !undergroundView) {
    return null;
  }
  return { position: [centreCell.x, houseY, centreCell.z], angle, labelY };
}

export function elevatedCellCandidateFromGroundClick(
  pos: { x: number; z: number },
  height: number = OVERPASS_HEIGHT
): { x: number; z: number } {
  return { x: Math.round(pos.x + height), z: Math.round(pos.z + height) };
}
