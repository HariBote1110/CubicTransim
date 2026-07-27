// 駅テンプレート(定型レイアウト)。「十字の乗り換え駅」「相対式2面2線」のような
// よくある駅の形をデータとして定義し、railMapへまとめて適用する純粋関数を提供する。
//
// 判定ロジック(平地判定・車庫上書き禁止・駅の交差統合など)は construction.ts の
// applyStation/applyRailPath に既にあるため、ここではそれらを1セルずつ呼び出して
// 組み立てるだけにし、判定を二重に書かない。
import { toKey } from '../utils';
import type { TerrainType, TownData } from '../types';
import { applyStation, applyRailPath, type ConstructionState } from './construction';

export type TemplateCellKind = 'station' | 'rail';

export interface TemplateCell {
  /** アンカー(設置基準セル)からの相対x */
  dx: number;
  /** アンカーからの相対z */
  dz: number;
  kind: TemplateCellKind;
}

export interface StationTemplate {
  id: string;
  name: string;
  description: string;
  cells: TemplateCell[];
}

const EMPTY_TERRAIN: Map<string, TerrainType> = new Map();

// アンカーからの相対座標(dx,dz)を、quarterTurns回(1回=時計回り90度)だけ回転する。
// 東(1,0)は1回転で南(0,1)、2回転で西(-1,0)、3回転で北(0,-1)になる。
// -0 を避けるため +0 に正規化する(そのままだと toEqual や座標キー化で -0 が紛れ込む)。
const normalizeZero = (n: number): number => (n === 0 ? 0 : n);
const rotateOnce = (dx: number, dz: number): { dx: number; dz: number } => ({
  dx: normalizeZero(-dz),
  dz: normalizeZero(dx),
});

export function rotateTemplate(template: StationTemplate, quarterTurns: 0 | 1 | 2 | 3): StationTemplate {
  const cells = template.cells.map(c => {
    let dx = c.dx;
    let dz = c.dz;
    for (let i = 0; i < quarterTurns; i++) {
      const rotated = rotateOnce(dx, dz);
      dx = rotated.dx;
      dz = rotated.dz;
    }
    return { dx, dz, kind: c.kind };
  });
  return { ...template, cells };
}

// 'cross': 十字乗換駅。東西・南北それぞれ長さ5の駅セル列が中心(0,0)で交差する(合計9セル)。
const CROSS_TEMPLATE: StationTemplate = {
  id: 'cross',
  name: '十字乗換駅',
  description: '南北・東西のホームが中心で直交する乗り換え駅(西国分寺駅のような形)。',
  cells: (() => {
    const cells: TemplateCell[] = [];
    for (let dx = -2; dx <= 2; dx++) cells.push({ dx, dz: 0, kind: 'station' });
    for (let dz = -2; dz <= 2; dz++) {
      if (dz === 0) continue; // 中心(0,0)は上のループで既に追加済み
      cells.push({ dx: 0, dz, kind: 'station' });
    }
    return cells;
  })(),
};

// 'through': 相対式2面2線。平行な長さ4の駅セル列を1セル間隔(=隣接する2列)で並べる。
// 隣接するため、設置すると applyStation の交差統合により自動的に1つの駅になる。
const THROUGH_TEMPLATE: StationTemplate = {
  id: 'through',
  name: '相対式2面2線',
  description: '隣接する2本のホームからなる対向式の駅。',
  cells: (() => {
    const cells: TemplateCell[] = [];
    for (let dx = 0; dx < 4; dx++) {
      cells.push({ dx, dz: 0, kind: 'station' });
      cells.push({ dx, dz: 1, kind: 'station' });
    }
    return cells;
  })(),
};

export const STATION_TEMPLATES: StationTemplate[] = [CROSS_TEMPLATE, THROUGH_TEMPLATE];

interface Pos { x: number; z: number }

/** テンプレートをアンカー位置・回転込みの絶対座標セル列に変換する。 */
export function templateAbsoluteCells(
  anchor: Pos,
  template: StationTemplate,
  quarterTurns: 0 | 1 | 2 | 3
): { x: number; z: number; kind: TemplateCellKind }[] {
  const rotated = rotateTemplate(template, quarterTurns);
  return rotated.cells.map(c => ({ x: anchor.x + c.dx, z: anchor.z + c.dz, kind: c.kind }));
}

// 8方向の隣接判定(dx,dzがともに-1〜1で(0,0)でない)。rail同士の接続に使う。
const isAdjacent = (a: Pos, b: Pos): boolean => {
  const dx = Math.abs(a.x - b.x);
  const dz = Math.abs(a.z - b.z);
  return dx <= 1 && dz <= 1 && !(dx === 0 && dz === 0);
};

/**
 * テンプレートをrailMapへ適用する。all-or-nothing: 1セルでも設置できなければ
 * (地形・車庫との衝突など、applyStation/applyRailPathがno-opを返す場合)stateを一切変更せず返す。
 *
 * 実装方針: 判定を二重に書かないため、実際にapplyStation/applyRailPathを順番に適用してみて、
 * 各駅セルが期待通り type==='station' になっているかを確認する(construction.tsのno-op規約=
 * 「変化が無ければ何もしない」性質を利用する。buildPreview.tsのevaluateBuildと同じ考え方)。
 */
export function applyStationTemplate(
  state: ConstructionState,
  anchor: Pos,
  template: StationTemplate,
  quarterTurns: 0 | 1 | 2 | 3 = 0,
  towns: TownData[] = [],
  terrain: Map<string, TerrainType> = EMPTY_TERRAIN
): ConstructionState {
  const cells = templateAbsoluteCells(anchor, template, quarterTurns);
  const stationCells = cells.filter(c => c.kind === 'station');
  const railCells = cells.filter(c => c.kind === 'rail');

  let working = state;

  // 駅セルを設置する(交差統合はapplyStation自身が行う)
  for (const cell of stationCells) {
    working = applyStation(working, cell, terrain, towns);
    const placed = working.railMap.get(toKey(cell.x, cell.z));
    if (!placed || placed.type !== 'station') {
      // 車庫との衝突・地形制約などで設置できなかった → all-or-nothing で全体を破棄
      return state;
    }
  }

  // rail種別のセルを設置する(単独では孤立点になるため、テンプレート内の隣接セルと接続する)
  for (const cell of railCells) {
    for (const other of cells) {
      if (other === cell) continue;
      if (!isAdjacent(cell, other)) continue;
      working = applyRailPath(working, [{ x: cell.x, z: cell.z }, { x: other.x, z: other.z }], terrain);
    }
    const placed = working.railMap.get(toKey(cell.x, cell.z));
    if (!placed) {
      return state;
    }
  }

  return working;
}
