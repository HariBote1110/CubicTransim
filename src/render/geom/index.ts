// R4e: `import * as THREE from 'three'` を `import * as THREE from '../render/geom'`
// (または相対パス)へ置き換えるだけで済むよう、three.js が使われていた範囲の名前を
// そのまま再エクスポートする。実体は同一ディレクトリの各モジュール参照。
export { BufferGeometry, BufferAttribute, Float32BufferAttribute } from './geom';
export type { AttributeLike, BoundingBox } from './geom';
export {
  BoxGeometry, CylinderGeometry, ConeGeometry, CircleGeometry, IcosahedronGeometry, OctahedronGeometry,
} from './primitives';
export { Shape, ExtrudeGeometry } from './shape';
export type { Point2D, ExtrudeOptions } from './shape';
