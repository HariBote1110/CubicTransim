// R4b: 信号機のジオメトリ生成を components/SignalBlock.tsx から抽出した純粋関数。
// 形状・寸法は SignalBlock.tsx のJSXと同じ(小さな固定形状の複製。depotGeometry.tsと
// 同じ理由でこの形にしている)。
import * as THREE from './geom';
import { PALETTE } from './palette';
import { SIGNAL_COLOUR } from '../types';
import type { SignalKind } from '../types';
import { getVectorFromDir } from '../utils';
import type { ShadedGeometryEntry } from './stationGeometry';

const MAST_COLOUR = '#333';
const HEAD_COLOUR = '#222';
const LIGHT_COLOUR = '#00ff00';

// S2(信号の種別)での灯火色の作り分け。既定(kind未指定/'block')は従来どおりの緑。
// 場内は青、出発は黄。挙動には影響しない見た目だけの区別(小さな変更に留める)。
const LIGHT_COLOUR_BY_KIND: Record<SignalKind, string> = {
  block: LIGHT_COLOUR,
  home: '#3399ff',
  departure: '#ffcc00',
};

/** 地面マーカーの頂点色アルファ(three.js側 opacity 0.6 相当)。 */
export const SIGNAL_MARKER_ALPHA = Math.round(0.6 * 255);

/** 信号機1つぶんを、ワールド座標(position)+許可方向(dir)+種別(kind)で配置して生成する。 */
export function buildSignalGeometries(
  position: readonly [number, number, number],
  dir: number,
  kind: SignalKind = 'block',
): ShadedGeometryEntry[] {
  const v = getVectorFromDir(dir);
  const rotation = Math.atan2(v.x, v.z);
  const [x, y, z] = position;
  const lightColour = LIGHT_COLOUR_BY_KIND[kind] ?? LIGHT_COLOUR;
  const entries: ShadedGeometryEntry[] = [];
  const push = (geometry: THREE.BufferGeometry, colour: string, translucent = false) => {
    geometry.rotateY(rotation);
    geometry.translate(x, y, z);
    entries.push({ geometry, colour, translucent });
  };

  const mast = new THREE.CylinderGeometry(0.03, 0.03, 0.5);
  mast.translate(0.3, 0.25, 0);
  push(mast, MAST_COLOUR);

  const head = new THREE.BoxGeometry(0.12, 0.16, 0.12);
  head.translate(0.3, 0.42, 0);
  push(head, HEAD_COLOUR);

  const light = new THREE.CylinderGeometry(0.035, 0.035, 0.02);
  light.rotateX(Math.PI / 2);
  light.translate(0.3, 0.42, 0.07);
  push(light, lightColour);

  const shaft = new THREE.BoxGeometry(0.08, 0.02, 0.5);
  shaft.translate(0, 0.03, -0.05);
  push(shaft, PALETTE.chevron);

  const leftWing = new THREE.BoxGeometry(0.08, 0.025, 0.3);
  leftWing.rotateY(Math.PI / 5);
  leftWing.translate(-0.09, 0.03, 0.18);
  push(leftWing, PALETTE.chevron);

  const rightWing = new THREE.BoxGeometry(0.08, 0.025, 0.3);
  rightWing.rotateY(-Math.PI / 5);
  rightWing.translate(0.09, 0.03, 0.18);
  push(rightWing, PALETTE.chevron);

  const marker = new THREE.CircleGeometry(0.06, 8);
  marker.rotateX(-Math.PI / 2);
  marker.translate(0, 0.021, -0.35);
  push(marker, SIGNAL_COLOUR, true);

  return entries;
}
