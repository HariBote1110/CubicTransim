// トンネル(山岳セルに敷設した線路)の純粋ロジック。React/THREE には依存しない。
//
// OpenTTD風に、トンネルは山肌を貫くものとして扱う: 内部のセルは地形ブロックに
// 埋もれて見えず、山肌(=tunnelでない隣接セルとの境界)にだけ坑口(ポータル)が現れる。
// このファイルは「どのセル・どの方向が坑口か」「ある座標がトンネル内部か」を
// railMap から純粋に導出する。描画(坑口ファサードの形状)はrender層の責務。
import { toKey, fromKey, getVectorFromDir, getOppositeDir, DIR } from '../utils';
import type { CellData } from '../types';
import { elevationAt, cellCornersFromMap } from './terrain';
import { OVERPASS_HEIGHT } from './trackPath';

const ALL_DIRS = [DIR.N, DIR.NE, DIR.E, DIR.SE, DIR.S, DIR.SW, DIR.W, DIR.NW];

export interface TunnelPortal {
  x: number;
  z: number;
  /** 坑口が向く方向(隣接する非tunnelセルへの単位ベクトル)。 */
  dx: number;
  dz: number;
}

const pushPortal = (portals: TunnelPortal[], x: number, z: number, dir: number): void => {
  const { x: dx, z: dz } = getVectorFromDir(dir);
  portals.push({ x, z, dx, dz });
};

/**
 * tunnelセルの坑口(山肌に面した出入口)を列挙する。
 *
 * 2つのケースを考慮する:
 * - 接続方向の先の隣接セルがtunnelでない(=そのまま地上の線路へ繋がっている)場合、
 *   その接続方向自体が坑口になる(例: 単セルトンネルの両側)。
 * - そのセルの接続が1方向しかない(=トンネル区間内での行き止まり)場合、まだ線路が
 *   延びていない反対方向が坑口になる(例: 直線トンネルの両端セル。連結先セルは
 *   トンネル内部なので上のケースには該当しないが、未接続側は山肌の入口とみなす)。
 *   ただし反対方向の隣接セルがまだmountain(標高>0)なら、そこは山の内部でしかなく
 *   山肌ではないため坑口を作らない(elevationで判定する。地表で終端している場合
 *   だけ坑口になる)。
 * 両ケースが同じ方向を指すことはない(接続方向とその反対方向は常に異なるため)ので
 * 重複は起きない。
 *
 * @param elevation sim/terrain.ts の computeElevation の結果。行き止まり坑口が
 *   山の内部を突き破らないようにするための判定にのみ使う。
 */
export function tunnelPortals(railMap: Map<string, CellData>, elevation: Map<string, number>): TunnelPortal[] {
  const portals: TunnelPortal[] = [];

  for (const [key, cell] of railMap) {
    if (!cell.tunnel) continue;
    const { x, z } = fromKey(key);
    const conns = cell.connections ?? 0;
    const connectedDirs = ALL_DIRS.filter(dir => (conns & dir) !== 0);

    for (const dir of connectedDirs) {
      const { x: dx, z: dz } = getVectorFromDir(dir);
      const neighbour = railMap.get(toKey(x + dx, z + dz));
      if (!neighbour?.tunnel) pushPortal(portals, x, z, dir);
    }

    if (connectedDirs.length === 1) {
      const oppositeDir = getOppositeDir(connectedDirs[0]);
      const { x: dx, z: dz } = getVectorFromDir(oppositeDir);
      if (elevationAt(elevation, x + dx, z + dz) <= 0) {
        pushPortal(portals, x, z, oppositeDir);
      }
    }
  }

  return portals;
}

/**
 * 座標(四捨五入)のセルがtunnelかどうか。列車の車両表示を隠すかどうかの判定に使う。
 * 坑口セル自身も内部扱い(地形ブロックに埋まるため、坑口の枠内で列車が見えるのは
 * OpenTTD風の見た目としても不自然)。
 */
export function isInTunnelInterior(railMap: Map<string, CellData>, x: number, z: number): boolean {
  const cell = railMap.get(toKey(Math.round(x), Math.round(z)));
  return !!cell?.tunnel;
}

/**
 * 高架レール(cell.uppers[level])のセルが山岳の内部に完全に埋もれているかどうか。
 * 地平のtunnel(construction.tsのterrainFlagsが敷設時に付与する保存済みフラグ)とは
 * 異なり、高架の橋桁(applyElevatedPathのspanセル)にはトンネル相当のフラグが
 * 保存されない。そのため、そのセルの4隅のコーナー標高(buildCornerElevationMap)が
 * すべてそのレベルの高さぶん(=level)以上あるかどうかで動的に判定する。
 *
 * 4隅すべて(1隅だけの標高ではなく)を要求するのは、コーナー標高は隣接セルの
 * min則で決まるため、1隅でも標高不足だとその方向の地形がまだ低く/狭く、
 * 坑口の箱(幅1.0×そのレベルの高さ)がそこだけ地形からはみ出して浮いて見える
 * (ユーザー報告: 「箱の底・背後・左右に隙間ができる」)。bilinear的な地形面は
 * 4隅の最小値を下回らないため、4隅すべてlevel以上であれば、そのセルの
 * footprint全体(側面・天面・底面すべて)がそのレベルの高さぶん地形に埋まる
 * ことが保証される。
 */
export function isMountainInteriorAtLevel(
  cornerElevation: Map<string, number>, x: number, z: number, level: number,
): boolean {
  const corners = cellCornersFromMap(cornerElevation, x, z);
  return corners.every(h => h >= level);
}

export interface ElevatedTunnelPortal extends TunnelPortal {
  level: 1 | 2 | 3;
}

/** 高架レール(uppers[level])のセルどうしを、その接続方向でつないだ連結成分(BFS)。 */
function elevatedComponents(railMap: Map<string, CellData>, level: 1 | 2 | 3): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const key of railMap.keys()) {
    if (visited.has(key) || !railMap.get(key)?.uppers?.[level]) continue;
    const component: string[] = [];
    const stack = [key];
    visited.add(key);

    while (stack.length > 0) {
      const k = stack.pop() as string;
      component.push(k);
      const { x, z } = fromKey(k);
      const conns = railMap.get(k)?.uppers?.[level]?.connections ?? 0;

      for (const dir of ALL_DIRS) {
        if ((conns & dir) === 0) continue;
        const { x: dx, z: dz } = getVectorFromDir(dir);
        const nk = toKey(x + dx, z + dz);
        if (visited.has(nk) || !railMap.get(nk)?.uppers?.[level]) continue;
        visited.add(nk);
        stack.push(nk);
      }
    }

    components.push(component);
  }

  return components;
}

interface ElevatedTunnelLevelData {
  /** そのレベルで「山に完全に埋もれている(=非表示にすべき)」セルのキー集合。 */
  interior: Set<string>;
  portals: ElevatedTunnelPortal[];
}

/**
 * 1つの連結成分(直線・曲線でつながった同一レベルの高架レール群)について、
 * 「山に埋もれているセル」と「坑口」を求める。
 *
 * 各セルの内外判定にはisMountainInteriorAtLevel(4隅すべてlevel以上)を使うのが
 * 基本だが、山が薄すぎる(例: 進行方向に対して1セル幅しかない土手状の地形)場合、
 * どのセルも4隅すべては条件を満たせず(必ずどこかの隅が非mountain隣接セルに
 * 引っ張られて0になる)、成分内の全セルが「常に露出」判定になってしまう。
 * これは「坑口が浮く」不具合よりも悪い後退(トンネル効果が完全に消える)なので、
 * 成分内に1つもisMountainInteriorAtLevelを満たすセルが無い場合だけ、
 * 従来の判定(そのセル自身の標高がlevel以上か、cellCornerElevationsより粗いが
 * 単純なelevationAt)にフォールバックする。
 */
function computeElevatedTunnelLevelData(
  railMap: Map<string, CellData>,
  cornerElevation: Map<string, number>,
  elevation: Map<string, number>,
  level: 1 | 2 | 3,
): ElevatedTunnelLevelData {
  const interior = new Set<string>();
  const portals: ElevatedTunnelPortal[] = [];

  for (const component of elevatedComponents(railMap, level)) {
    const cornerTest = (x: number, z: number): boolean => isMountainInteriorAtLevel(cornerElevation, x, z, level);
    const scalarTest = (x: number, z: number): boolean => elevationAt(elevation, x, z) >= level;
    const hasCornerInterior = component.some(k => {
      const { x, z } = fromKey(k);
      return cornerTest(x, z);
    });
    const isInterior = hasCornerInterior ? cornerTest : scalarTest;

    for (const key of component) {
      const { x, z } = fromKey(key);
      if (!isInterior(x, z)) continue;
      interior.add(key);

      const upper = railMap.get(key)?.uppers?.[level];
      const conns = upper?.connections ?? 0;
      const connectedDirs = ALL_DIRS.filter(dir => (conns & dir) !== 0);

      for (const dir of connectedDirs) {
        const { x: dx, z: dz } = getVectorFromDir(dir);
        const nx = x + dx;
        const nz = z + dz;
        const neighbourHasUpper = !!railMap.get(toKey(nx, nz))?.uppers?.[level];
        if (!neighbourHasUpper || !isInterior(nx, nz)) portals.push({ x, z, dx, dz, level });
      }

      if (connectedDirs.length === 1) {
        const oppositeDir = getOppositeDir(connectedDirs[0]);
        const { x: dx, z: dz } = getVectorFromDir(oppositeDir);
        if (!isInterior(x + dx, z + dz)) portals.push({ x, z, dx, dz, level });
      }
    }
  }

  return { interior, portals };
}

/** レベル(1〜3)ごとの高架トンネル判定結果。GameScene側でrailMap/terrain変更時にのみ
 *  再計算し(useMemo)、毎フレームのDynamicTrainからはSet参照だけで済ませる想定。 */
export type ElevatedTunnelIndex = Map<1 | 2 | 3, ElevatedTunnelLevelData>;

/**
 * 高架レベル1〜3すべてについて、山岳内部に埋もれているセルと坑口を一括計算する。
 * @param cornerElevation buildCornerElevationMapの結果(坑口位置が地形の斜面へ
 *   ちょうど乗る/めり込む位置に来るよう、4隅すべての標高で内外判定するために使う)。
 * @param elevation computeElevationの結果(コーナー基準では山が薄すぎて内部セルが
 *   1つも見つからない場合のフォールバック判定にのみ使う)。
 */
export function buildElevatedTunnelIndex(
  railMap: Map<string, CellData>,
  cornerElevation: Map<string, number>,
  elevation: Map<string, number>,
): ElevatedTunnelIndex {
  const index = new Map<1 | 2 | 3, ElevatedTunnelLevelData>();
  for (const level of [1, 2, 3] as const) {
    index.set(level, computeElevatedTunnelLevelData(railMap, cornerElevation, elevation, level));
  }
  return index;
}

/** そのレベルの高架坑口一覧(buildElevatedTunnelIndexの結果から取り出すだけ)。 */
export function elevatedTunnelPortals(index: ElevatedTunnelIndex, level: 1 | 2 | 3): ElevatedTunnelPortal[] {
  return index.get(level)?.portals ?? [];
}

/**
 * 座標(四捨五入)のそのレベルの高架セルが、山岳の内部に埋もれているかどうか。
 * 列車の車両表示を隠すかどうかの判定に使う(isInTunnelInteriorの高架版)。
 * level<=0(地平)は常にfalse(地平はisInTunnelInteriorが担当する)。
 */
export function isInElevatedTunnelInterior(
  index: ElevatedTunnelIndex, x: number, z: number, level: number,
): boolean {
  if (level <= 0) return false;
  const key = toKey(Math.round(x), Math.round(z));
  return !!index.get(level as 1 | 2 | 3)?.interior.has(key);
}

/**
 * 列車の描画位置(x,z,renderPos.y)から、地平・高架どちらのトンネルにも対応した
 * 「非表示にすべきか」を判定する。DynamicTrainのuseFrameで先頭車・後続車の座標に
 * 使う。renderPos.yは0.5(地平)または0.5+level*OVERPASS_HEIGHT(高架レベルlevel)
 * が基準(sim/consist.ts・sim/simulation.ts参照)なので、そこからlevelを逆算する。
 * 坂の途中などlevelの境界に満たない半端なyは四捨五入で最寄りのレベルに寄せるが、
 * そのレベルの高架セルが実際には無い(=まだ坂の途中)場合はisInElevatedTunnelInterior
 * 側がfalseを返すため、誤って隠れることはない。
 */
export function isTrainHiddenInTunnel(
  railMap: Map<string, CellData>, index: ElevatedTunnelIndex, x: number, z: number, y: number,
): boolean {
  const level = Math.round((y - 0.5) / OVERPASS_HEIGHT);
  if (level <= 0) return isInTunnelInterior(railMap, x, z);
  return isInElevatedTunnelInterior(index, x, z, level);
}
