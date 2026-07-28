// 立体交差の十字乗り換え駅の描画に必要な、地平/高架それぞれの駅セル集計。
//
// データモデル上は「upperを持ち、かつupper.stationIdがあるセル」が高架駅セルで、
// stationId無しのupperは単なる橋桁(駅ではない)。この判定はsim層(construction.ts等)
// と同じ定義を描画側でも使い回す(progress/cross-elevated-station-data-model.md参照)。
import type { CellData } from '../types';
import { fromKey } from '../utils';
import { OVERPASS_HEIGHT, MAX_ELEVATED_LEVEL } from '../sim/trackPath';

const ELEVATED_LEVELS = Array.from({ length: MAX_ELEVATED_LEVEL }, (_, i) => (i + 1) as 1 | 2 | 3);

export interface StationLayerCell {
  key: string;
  x: number;
  z: number;
  stationId: string;
  connections: number;
  /** このセルの高架駅ホームがあるレベル(1〜MAX_ELEVATED_LEVEL)。地平セルでは省略(=1相当)。 */
  level?: 1 | 2 | 3;
}

/** 指定レベルの高架駅セルかどうか(uppers[level]を持ち、かつstationIdがある)。 */
export const isElevatedStationCell = (cell: CellData | undefined, level: 1 | 2 | 3 = 1): boolean =>
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
  const out: StationLayerCell[] = [];
  for (const [key, data] of railMap) {
    for (const level of ELEVATED_LEVELS) {
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
export function elevatedCellCandidateFromGroundClick(
  pos: { x: number; z: number },
  height: number = OVERPASS_HEIGHT
): { x: number; z: number } {
  return { x: Math.round(pos.x + height), z: Math.round(pos.z + height) };
}
