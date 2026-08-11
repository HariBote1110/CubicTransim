// R4b: 車庫(検車区)のジオメトリ生成を components/DepotBlock.tsx から抽出した純粋関数。
// 形状・寸法は DepotBlock.tsx のJSXと同じ(そちらが見た目の一次情報源。数値は複製だが、
// 車庫は9メッシュの小さな固定形状で、退役予定(R4d)のclassicパスと共有する価値より
// 現時点でのJSX破壊リスクのほうが大きいため、意図的にこの形で複製している)。
import * as THREE from './geom';
import { PALETTE } from './palette';
import type { ShadedGeometryEntry } from './stationGeometry';

const FLOOR_COLOUR = '#9a978f';
const OPENING_DARK_COLOUR = '#161b21';

/** 車庫1棟ぶんを、ワールド座標(position)+Y軸回転(rotation)で配置して生成する。 */
export function buildDepotGeometries(
  position: readonly [number, number, number],
  rotation = 0,
): ShadedGeometryEntry[] {
  const [x, y, z] = position;
  const entries: ShadedGeometryEntry[] = [];
  const push = (geometry: THREE.BufferGeometry, colour: string) => {
    geometry.rotateY(rotation);
    geometry.translate(x, y, z);
    entries.push({ geometry, colour });
  };

  const floor = new THREE.BoxGeometry(0.96, 0.08, 0.96);
  floor.translate(0, 0.04, 0);
  push(floor, FLOOR_COLOUR);

  for (const rx of [-0.125, 0.125]) {
    const rail = new THREE.BoxGeometry(0.045, 0.05, 0.9);
    rail.translate(rx, 0.11, 0);
    push(rail, PALETTE.railSteel);
  }

  for (const side of [-1, 1]) {
    const wall = new THREE.BoxGeometry(0.08, 0.62, 0.9);
    wall.translate(side * 0.42, 0.36, 0.03);
    push(wall, PALETTE.depotWall);
  }

  const rearWall = new THREE.BoxGeometry(0.92, 0.62, 0.08);
  rearWall.translate(0, 0.36, 0.44);
  push(rearWall, PALETTE.depotWall);

  const lintel = new THREE.BoxGeometry(0.92, 0.12, 0.08);
  lintel.translate(0, 0.62, -0.44);
  push(lintel, PALETTE.depotWall);

  const opening = new THREE.BoxGeometry(0.7, 0.5, 0.02);
  opening.translate(0, 0.3, -0.42);
  push(opening, OPENING_DARK_COLOUR);

  const roof = new THREE.BoxGeometry(1.02, 0.06, 1.02);
  roof.rotateX(-0.06);
  roof.translate(0, 0.71, 0);
  push(roof, PALETTE.depotRoof);

  return entries;
}
