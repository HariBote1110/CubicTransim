// トンネル(山岳セルに敷設した線路)の純粋ロジック。React/THREE には依存しない。
//
// OpenTTD風に、トンネルは山肌を貫くものとして扱う: 内部のセルは地形ブロックに
// 埋もれて見えず、山肌(=tunnelでない隣接セルとの境界)にだけ坑口(ポータル)が現れる。
// このファイルは「どのセル・どの方向が坑口か」「ある座標がトンネル内部か」を
// railMap から純粋に導出する。描画(坑口ファサードの形状)はrender層の責務。
import { toKey, fromKey, getVectorFromDir, getOppositeDir, DIR } from '../utils';
import type { CellData } from '../types';

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
 * 両ケースが同じ方向を指すことはない(接続方向とその反対方向は常に異なるため)ので
 * 重複は起きない。
 */
export function tunnelPortals(railMap: Map<string, CellData>): TunnelPortal[] {
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
      pushPortal(portals, x, z, getOppositeDir(connectedDirs[0]));
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
