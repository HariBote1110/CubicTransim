// 駅テンプレート(定型レイアウト)。「十字の乗り換え駅」「相対式2面2線」のような
// よくある駅の形をデータとして定義し、railMapへまとめて適用する純粋関数を提供する。
//
// 判定ロジック(平地判定・車庫上書き禁止・駅の交差統合など)は construction.ts の
// applyStation/applyRailPath に既にあるため、ここではそれらを1セルずつ呼び出して
// 組み立てるだけにし、判定を二重に書かない。
import { toKey } from '../utils';
import type { TerrainType, TownData } from '../types';
import {
  applyStation,
  applyRailPath,
  applyElevatedStation,
  type ConstructionState,
  type StationAxis,
} from './construction';

export type TemplateCellKind = 'station' | 'rail';

export interface TemplateCell {
  /** アンカー(設置基準セル)からの相対x */
  dx: number;
  /** アンカーからの相対z */
  dz: number;
  kind: TemplateCellKind;
  /**
   * 駅セルの接続の軸(南北/東西/交差)。kind==='station'のセルにのみ意味を持つ
   * (rail種別のセルでは無視される。回転時にrotateTemplateが一緒に回す)。
   */
  axis: StationAxis;
  /**
   * 立体交差の高架層かどうか(0=地平、省略時は0)。1のセルはkind==='station'で
   * かつ overpassLine も立っている必要がある(高架ホームは常に坂+橋桁の一部)。
   */
  layer?: 0 | 1;
  /**
   * 立体交差の「坂+橋桁」からなる一直線(オーバーパス)に属することを示す。
   * このフラグを持つセルは個別にapplyStation/applyRailPathを呼ばず、
   * applyStationTemplateがoverpassLine上のセルをまとめて並べ、
   * applyElevatedStation(construction.tsの専用ロジック)へ一括で渡す
   * (坂のramp・橋桁のupperはこの専用ロジックでしか作れないため)。
   * 坂の4セル(両端2セルずつ)はkind:'rail'、桁(=ホーム)はkind:'station'・layer:1にする。
   */
  overpassLine?: boolean;
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

// 軸を90度単位で回転する。90度(奇数回)ごとにns/ewが入れ替わる。crossは常にcrossのまま。
const rotateAxis = (axis: StationAxis, quarterTurns: 0 | 1 | 2 | 3): StationAxis => {
  if (axis === 'cross') return 'cross';
  const flips = quarterTurns % 2 === 1;
  if (!flips) return axis;
  return axis === 'ns' ? 'ew' : 'ns';
};

export function rotateTemplate(template: StationTemplate, quarterTurns: 0 | 1 | 2 | 3): StationTemplate {
  const cells = template.cells.map(c => {
    let dx = c.dx;
    let dz = c.dz;
    for (let i = 0; i < quarterTurns; i++) {
      const rotated = rotateOnce(dx, dz);
      dx = rotated.dx;
      dz = rotated.dz;
    }
    return {
      dx, dz, kind: c.kind, axis: rotateAxis(c.axis, quarterTurns),
      layer: c.layer, overpassLine: c.overpassLine,
    };
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
    // 東西の腕(中心含む): 中心だけは両軸を持つcross、それ以外はew
    for (let dx = -2; dx <= 2; dx++) cells.push({ dx, dz: 0, kind: 'station', axis: dx === 0 ? 'cross' : 'ew' });
    for (let dz = -2; dz <= 2; dz++) {
      if (dz === 0) continue; // 中心(0,0)は上のループで既に追加済み
      cells.push({ dx: 0, dz, kind: 'station', axis: 'ns' });
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
    // 東西方向に伸びる2本のホーム
    for (let dx = 0; dx < 4; dx++) {
      cells.push({ dx, dz: 0, kind: 'station', axis: 'ew' });
      cells.push({ dx, dz: 1, kind: 'station', axis: 'ew' });
    }
    return cells;
  })(),
};

// 'cross-elevated': 立体交差の十字乗り換え駅。地平の直線ホーム(軸A、南北)5セルの上を、
// 高架ホーム(軸B、東西)が直交して跨ぐ。高架側は「坂2セル+橋桁(ホーム)3セル+坂2セル」の
// 一直線(overpassLine)で、坂は construction.ts の applyElevatedStation でしか作れないため、
// overpassLine:true を付けて applyStationTemplate 側でまとめて処理させる。
// 中心(0,0)は地平ホーム(軸A)と高架橋桁(軸B)の両方に属する唯一のセル
// (地平駅の真上を高架駅が跨ぐ、という立体交差の核心部分)。
const CROSS_ELEVATED_TEMPLATE: StationTemplate = {
  id: 'cross-elevated',
  name: '立体交差十字駅',
  description: '地平のホームの上を、直交する高架ホームが跨ぐ立体交差の乗り換え駅。',
  cells: (() => {
    const cells: TemplateCell[] = [];
    // 地平ホーム(軸A、南北): 中心(0,0)含め5セル
    for (let dz = -2; dz <= 2; dz++) cells.push({ dx: 0, dz, kind: 'station', axis: 'ns' });
    // 高架オーバーパス(軸B、東西): 坂2+桁3+坂2の一直線(dx=-3..3)
    for (let dx = -3; dx <= 3; dx++) {
      const isSpan = dx >= -1 && dx <= 1; // 橋桁(=高架ホーム)は中央3セル
      if (isSpan) {
        cells.push({ dx, dz: 0, kind: 'station', axis: 'ew', layer: 1, overpassLine: true });
      } else {
        cells.push({ dx, dz: 0, kind: 'rail', axis: 'ew', overpassLine: true });
      }
    }
    return cells;
  })(),
};

export const STATION_TEMPLATES: StationTemplate[] = [CROSS_TEMPLATE, THROUGH_TEMPLATE, CROSS_ELEVATED_TEMPLATE];

interface Pos { x: number; z: number }

type AbsoluteTemplateCell = {
  x: number;
  z: number;
  kind: TemplateCellKind;
  axis: StationAxis;
  layer?: 0 | 1;
  overpassLine?: boolean;
};

/** テンプレートをアンカー位置・回転込みの絶対座標セル列に変換する。 */
export function templateAbsoluteCells(
  anchor: Pos,
  template: StationTemplate,
  quarterTurns: 0 | 1 | 2 | 3
): AbsoluteTemplateCell[] {
  const rotated = rotateTemplate(template, quarterTurns);
  return rotated.cells.map(c => ({
    x: anchor.x + c.dx, z: anchor.z + c.dz, kind: c.kind, axis: c.axis,
    layer: c.layer, overpassLine: c.overpassLine,
  }));
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
  // overpassLineのセル(立体交差の坂+橋桁)は、地平のapplyStation/applyRailPathでは
  // 組み立てられない(rampやupperはapplyElevatedStation専用ロジックでしか作れない)ため、
  // ここで切り分けて別扱いにする。
  const groundCells = cells.filter(c => !c.overpassLine);
  const overpassCells = cells.filter(c => c.overpassLine);

  const stationCells = groundCells.filter(c => c.kind === 'station');
  const railCells = groundCells.filter(c => c.kind === 'rail');

  let working = state;

  // 駅セルを設置する(交差統合はapplyStation自身が行う)
  for (const cell of stationCells) {
    working = applyStation(working, cell, terrain, towns, cell.axis);
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

  // 高架オーバーパス(坂+橋桁)を一直線に並べ、applyElevatedStationへまとめて渡す。
  if (overpassCells.length > 0) {
    // 軸(dx方向かdz方向か)を判定して並べ替え、坂→橋桁→坂の順の一直線パスを作る。
    const sameZ = overpassCells.every(c => c.z === overpassCells[0].z);
    const sorted = [...overpassCells].sort((a, b) => (sameZ ? a.x - b.x : a.z - b.z));
    const path = sorted.map(c => ({ x: c.x, z: c.z }));

    // 橋桁が地平駅の交差点と重なっていれば、その駅IDへ統合する
    // (1つの駅IDに地平ホーム群と高架ホーム群が両方ぶら下がる形にするため)。
    let groundStationId: string | undefined;
    for (const p of path) {
      const existing = working.railMap.get(toKey(p.x, p.z));
      if (existing?.type === 'station' && existing.stationId) {
        groundStationId = existing.stationId;
        break;
      }
    }

    const before = working;
    working = applyElevatedStation(working, path, terrain, towns, groundStationId);
    if (working === before) return state; // 高架化に失敗 → all-or-nothing

    // 橋桁(=ホーム)にしたかったセルが実際に高架ホーム化しているか確認する
    const spanCells = sorted.filter(c => c.layer === 1);
    for (const sc of spanCells) {
      const placed = working.railMap.get(toKey(sc.x, sc.z));
      if (!placed?.upper?.stationId) return state;
    }
  }

  return working;
}
