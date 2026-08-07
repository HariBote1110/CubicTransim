// P7a: 標高上の建設(勾配レール)のための純粋な斜面モデル。
// progress/slope-construction-design.md の設計に基づく。React/THREE非依存、construction.ts/
// 描画への配線はまだ行わない(additive: このファイル単体で完結する)。
//
// セル形状は cellCornerHeights([nw,ne,sw,se])から都度導出する(保存しない)。1-Lipschitz
// (隣接コーナー標高差1以下、terrainField.tsが構成保証)を前提に、以下の3パターンに分類する:
//   - flat: 4隅すべて同じ標高
//   - incline: 一辺(2隅)がもう一辺(2隅)より+1高い。dirは「高い側」の方角(=登る方向)
//   - other: それ以外(1隅/3隅だけ高い、対角鞍点=尾根谷)。線路は敷けない

import type { CellCorners, TerrainField } from './terrainField';
import type { CellData } from '../types';
import { DIR, getDirFromVector, getOppositeDir } from '../utils';
import { OVERPASS_HEIGHT } from './trackPath';

export type SlopeInfo =
  | { kind: 'flat'; height: number }
  | { kind: 'incline'; dir: number; low: number; high: number }
  | { kind: 'other' };

/** incline セルのコストはflatの何倍か(P7bで建設コストへ配線する。ここでは未使用の定数)。 */
export const SLOPE_RAIL_COST_MULTIPLIER = 2;

// flatセルで許可する全方向(4方位+4対角)。construction.tsのgetGroundConnectionBits等が
// 地平の平坦セルに対して使っているのと同じ全方向集合。
const ALL_GROUND_DIRS =
  DIR.N | DIR.NE | DIR.E | DIR.SE | DIR.S | DIR.SW | DIR.W | DIR.NW;

/**
 * 4隅コーナー標高からセルの斜面形状を分類する。
 * corners = [nw, ne, sw, se]。1-Lipschitz(隣接差1以下)を前提とするため、
 * 「高い側」と「低い側」の差は常にちょうど1になる(incline判定時)。
 */
export function slopeOf(corners: CellCorners): SlopeInfo {
  const [nw, ne, sw, se] = corners;
  if (nw === ne && ne === sw && sw === se) {
    return { kind: 'flat', height: nw };
  }

  // 一辺(2隅)がもう一辺より+1高い4パターンだけをincline扱いにする。
  // N辺(nw,ne)がS辺(sw,se)より高い→dir=N(北へ登る)、以下同様。
  const edges: ReadonlyArray<[number, [number, number], [number, number]]> = [
    [DIR.N, [nw, ne], [sw, se]],
    [DIR.S, [sw, se], [nw, ne]],
    [DIR.E, [ne, se], [nw, sw]],
    [DIR.W, [nw, sw], [ne, se]],
  ];
  for (const [dir, high, low] of edges) {
    if (high[0] === high[1] && low[0] === low[1] && high[0] === low[0] + 1) {
      return { kind: 'incline', dir, low: low[0], high: high[0] };
    }
  }

  return { kind: 'other' };
}

/**
 * slopeが許す線路の接続方向をDIRビットマスクで返す。
 * flat→全8方向、incline→傾斜軸に沿った2方向のみ(uphill方向とその逆)、other→0。
 */
export function allowedRailConnections(slope: SlopeInfo): number {
  if (slope.kind === 'flat') return ALL_GROUND_DIRS;
  if (slope.kind === 'incline') return slope.dir | getOppositeDir(slope.dir);
  return 0;
}

/**
 * セルのdir方向側の辺を構成する2隅の標高を返す。corners=[nw,ne,sw,se]。
 * 順序は「隣接セルとの共有座標が一致する向き」で固定する(railEdgeContinuousが
 * 単純な要素比較で連続性を判定できるようにするため):
 *   N: [nw, ne]  S: [sw, se]  E: [ne, se]  W: [nw, sw]
 * 対角方向は共有点が1つしかないため、その頂点の標高を2要素とも同じ値で返す
 * (呼び出し側がN/S/E/Wと同じ形で扱えるようにする簡略表現)。
 *   NE: ne  SE: se  SW: sw  NW: nw
 */
export function edgeHeights(corners: CellCorners, dir: number): [number, number] {
  const [nw, ne, sw, se] = corners;
  switch (dir) {
    case DIR.N:
      return [nw, ne];
    case DIR.S:
      return [sw, se];
    case DIR.E:
      return [ne, se];
    case DIR.W:
      return [nw, sw];
    case DIR.NE:
      return [ne, ne];
    case DIR.SE:
      return [se, se];
    case DIR.SW:
      return [sw, sw];
    case DIR.NW:
      return [nw, nw];
    default:
      throw new Error(`edgeHeights: unsupported dir ${dir}`);
  }
}

const CARDINAL_DIRS = DIR.N | DIR.E | DIR.S | DIR.W;

/**
 * cornersAのセルからdirFromAtoB方向に隣接するcornersBのセルへ、線路が標高連続に繋がるか。
 *
 * - N/S/E/W: 共有辺の2隅標高が両セルで一致すること(edgeHeights(A,dir) と
 *   edgeHeights(B,opposite(dir)) が要素ごとに一致)。
 * - 対角(NE/SE/SW/NW): 斜め線路はincline上では許可しない(design doc 3.)ため、両セルとも
 *   flatであり、かつ共有コーナー(1点)の標高が一致することを要求する。
 */
export function railEdgeContinuous(
  cornersA: CellCorners,
  cornersB: CellCorners,
  dirFromAtoB: number
): boolean {
  if (dirFromAtoB & CARDINAL_DIRS) {
    const edgeA = edgeHeights(cornersA, dirFromAtoB);
    const edgeB = edgeHeights(cornersB, getOppositeDir(dirFromAtoB));
    return edgeA[0] === edgeB[0] && edgeA[1] === edgeB[1];
  }

  // 対角方向: incline上のdiagonalは禁止 → 両セルがflatであることが前提。
  const slopeA = slopeOf(cornersA);
  const slopeB = slopeOf(cornersB);
  if (slopeA.kind !== 'flat' || slopeB.kind !== 'flat') return false;

  const sharedA = edgeHeights(cornersA, dirFromAtoB)[0];
  const sharedB = edgeHeights(cornersB, getOppositeDir(dirFromAtoB))[0];
  return sharedA === sharedB;
}

/**
 * flat(4隅同値)のセルにのみ真を返す。駅・車庫・信号・町タイルの「平坦地限定」の
 * 事前条件として使う(任意標高では許可、傾斜地・otherは不許可)。
 */
export function canPlaceFlatStructure(slope: SlopeInfo): boolean {
  return slope.kind === 'flat';
}

export interface SlopeViolation {
  index: number;
  reason: 'other-slope' | 'direction-blocked' | 'edge-discontinuous';
}

interface Pos {
  x: number;
  z: number;
}

// path上のセルiが実際に必要とする接続方向(prev/nextへ向かう方向のみ)。
// construction.tsのmountainCellCandidateDirsと違い、行き止まりの反対側を候補として
// 足すことはしない(勾配可否の判定に実際使わない方向を混ぜないため)。
// P7bでconstruction.tsのresolveGroundRailPlanからも再利用するためexportする。
export const pathCellConnectionDirs = (path: Pos[], i: number): number[] => {
  const { x, z } = path[i];
  const dirs: number[] = [];
  if (i > 0) dirs.push(getDirFromVector(path[i - 1].x - x, path[i - 1].z - z));
  if (i < path.length - 1) dirs.push(getDirFromVector(path[i + 1].x - x, path[i + 1].z - z));
  return dirs;
};

/**
 * 建設パス(隣接するセル列)を標高規則に照らして検証する。construction.tsの
 * applyRailPathDetailedが呼ぶ想定(P7bで配線)。違反があったセルのindexとreasonを列挙する
 * (何も違反がなければ空配列)。
 *
 * 検出する違反:
 *   - 'other-slope': そのセルがother斜面(線路自体が敷けない)
 *   - 'direction-blocked': そのセルの斜面が、経路が必要とする接続方向を許可しない
 *   - 'edge-discontinuous': 隣接セル間で共有辺の標高が繋がらない(1セルで1段登る規則含む)
 */
/**
 * セル(x,z)を実際に線路が走る標高(P7b、construction.ts/render層向け)。
 * - flat: 4隅同値の標高そのもの
 * - incline: 低い側の辺の標高(=そのセルへ「下から」進入するときの基準面。design doc
 *   「LOW edge is the cell's base」の規約)。高い側はrailHeightAt(隣のflatセル)+1で
 *   自然に一致する(1セル1段規則)
 * - tunnel(cellにtunnel.heightがある場合): 地形コーナーは見ず、保存された高さをそのまま返す
 * - other(上記どちらでもない): 線路の自然な標高が定義できないため、最も低いコーナーへ
 *   便宜的にフォールバックする(呼び出し側はこのセルへ普通は線路を通さない前提)
 */
export function railHeightAt(
  field: TerrainField,
  cell: CellData | undefined,
  x: number,
  z: number
): number {
  if (cell?.tunnel) return cell.tunnel.height;
  const corners = field.cellCornerHeights(x, z);
  const slope = slopeOf(corners);
  if (slope.kind === 'flat') return slope.height;
  if (slope.kind === 'incline') return slope.low;
  return Math.min(...corners);
}

/**
 * P7c: railHeightAt(段数の整数)をワールドY単位(OVERPASS_HEIGHT基準)へ換算した高さ。
 * sim(renderPos/carPositions)・render(TrackNetwork/GameSceneの坑口・駅)の両方が
 * この1関数を経由することで、地形段数からワールド高さへの換算式を一箇所にまとめる
 * (CLAUDE.mdのtrackPath原則: レールと列車が同じ高さ式を共有しないとずれる)。
 */
export function groundRailCentreHeight(
  field: TerrainField,
  cell: CellData | undefined,
  x: number,
  z: number
): number {
  return railHeightAt(field, cell, x, z) * OVERPASS_HEIGHT;
}

/**
 * render/trackGeometry.tsのセル1つぶんの線路パーツ生成に渡す高さ情報。
 * flat/tunnelは単一の高さ(originY相当)、inclineはセルの低い側→高い側の2値
 * (buildGroundInclineTrackPartsへそのまま渡せる)を返す。
 * 「other」スロープ(線路が敷けない形状のはずだが、防御的にflat同然のフォールバックを返す)は
 * railHeightAtの最も低いコーナーへのフォールバックと同じ規約に合わせる。
 */
export type RailRenderHeight =
  | { kind: 'flat'; y: number }
  | { kind: 'incline'; dir: number; lowY: number; highY: number };

export function railRenderHeight(
  field: TerrainField,
  cell: CellData | undefined,
  x: number,
  z: number
): RailRenderHeight {
  if (cell?.tunnel) return { kind: 'flat', y: cell.tunnel.height * OVERPASS_HEIGHT };
  const corners = field.cellCornerHeights(x, z);
  const slope = slopeOf(corners);
  if (slope.kind === 'incline') {
    return { kind: 'incline', dir: slope.dir, lowY: slope.low * OVERPASS_HEIGHT, highY: slope.high * OVERPASS_HEIGHT };
  }
  if (slope.kind === 'flat') return { kind: 'flat', y: slope.height * OVERPASS_HEIGHT };
  return { kind: 'flat', y: Math.min(...corners) * OVERPASS_HEIGHT };
}

export function pathSlopeViolations(field: TerrainField, path: Pos[]): SlopeViolation[] {
  const violations: SlopeViolation[] = [];

  for (let i = 0; i < path.length; i++) {
    const { x, z } = path[i];
    const corners = field.cellCornerHeights(x, z);
    const slope = slopeOf(corners);

    if (slope.kind === 'other') {
      violations.push({ index: i, reason: 'other-slope' });
      continue;
    }

    const allowed = allowedRailConnections(slope);
    const neededDirs = pathCellConnectionDirs(path, i);
    if (neededDirs.some(dir => (allowed & dir) === 0)) {
      violations.push({ index: i, reason: 'direction-blocked' });
    }
  }

  for (let i = 0; i < path.length - 1; i++) {
    const curr = path[i];
    const next = path[i + 1];
    const dir = getDirFromVector(next.x - curr.x, next.z - curr.z);
    const cornersA = field.cellCornerHeights(curr.x, curr.z);
    const cornersB = field.cellCornerHeights(next.x, next.z);
    if (!railEdgeContinuous(cornersA, cornersB, dir)) {
      violations.push({ index: i, reason: 'edge-discontinuous' });
    }
  }

  return violations;
}
