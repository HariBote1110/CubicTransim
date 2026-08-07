// 描画専用のカラーパレットと共有マテリアル。
//
// 方針: 「Nゲージのジオラマ」を目標にしたローポリ表現。彩度を抑えた自然色を基調に、
// ホームの黄色い点字ブロックや車両の帯だけを彩度の高いアクセントにして視線を集める。
// sim層からは一切参照しない(描画専任レイヤー)。
import * as THREE from 'three';

export const PALETTE = {
  // --- 地面・地形 ---
  ground: '#9ab86f',
  grassLight: '#a6c47a',
  grassDark: '#87a95f',
  water: '#4a9fd4',
  waterDeep: '#3b83b0',
  shore: '#d9cfa8',
  rock: '#8c8677',
  rockDark: '#6f6a5e',
  rockSnow: '#e8e6df',

  // --- 線路 ---
  ballast: '#a89f92',
  sleeper: '#6b5a45',
  railSteel: '#8a8d92',

  // --- 立体交差(高架の橋脚・桁) ---
  overpassPier: '#7a7466',
  overpassDeck: '#5f5a50',

  // --- 掘割ランプの地表開口(P8b) ---
  undergroundPit: '#14140f',
  undergroundWall: '#736a5c',

  // --- 駅 ---
  platform: '#d8d5cd',
  platformSide: '#b9b5ab',
  tactile: '#f2c14e',
  canopyRoof: '#8d99a4',
  canopyPillar: '#98a0a8',
  platformDoor: '#dfe4e8',
  platformDoorGlass: '#9fc7de',

  // --- 車庫・信号 ---
  depotWall: '#3d6b93',
  depotRoof: '#2c4f6f',
  depotFloor: '#4a4a4a',
  signalMast: '#3a3f45',
  signalGo: '#39d353',
  chevron: '#ffcc00',

  // --- 車両 ---
  carBody: '#f3f5f8',
  carRoof: '#b6bdc4',
  carWindow: '#2b3a47',
  carSkirt: '#474f58',
  carBogie: '#2a2f35',
  carLine: '#1f8fd6',
  carLineSelected: '#ff2e63',
  headlight: '#fff6d5',
  taillight: '#ff5a5a',

  // --- 街 ---
  buildingA: '#d5cfc4',
  buildingB: '#c0b8ab',
  buildingC: '#a8b3bd',
  buildingRoof: '#8a5a4a',
  buildingRoofFlat: '#9a958c',
  roadAsphalt: '#5a5e63',
  roadKerb: '#a3a099',

  // --- 樹木 ---
  foliage: '#4f7c3a',
  foliageDark: '#3f6a30',
  trunk: '#6b4f36',
} as const;

// three.js の rotateY(theta) はローカル +Z 軸をワールド (sin θ, 0, cos θ) へ写す。
// 方向ベクトル (x, z) に一致する θ は atan2(x, z)。プロジェクト全体でこの規約を使う。
export const angleFromVector = (x: number, z: number): number => Math.atan2(x, z);

// --- 共有マテリアル(セル数が多いので必ず使い回す) ---
const std = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, ...extra });

export const MATERIALS = {
  ballast: std(PALETTE.ballast, { roughness: 1 }),
  sleeper: std(PALETTE.sleeper, { roughness: 1 }),
  rail: std(PALETTE.railSteel, { roughness: 0.35, metalness: 0.6 }),
  overpassPier: std(PALETTE.overpassPier, { roughness: 0.9 }),
  overpassDeck: std(PALETTE.overpassDeck, { roughness: 0.8, metalness: 0.15 }),
  undergroundPit: std(PALETTE.undergroundPit, { roughness: 1 }),
  undergroundWall: std(PALETTE.undergroundWall, { roughness: 0.95 }),

  platform: std(PALETTE.platform, { roughness: 0.9 }),
  platformSide: std(PALETTE.platformSide, { roughness: 1 }),
  tactile: std(PALETTE.tactile, { roughness: 0.8 }),
  canopyRoof: std(PALETTE.canopyRoof, { roughness: 0.7 }),
  canopyPillar: std(PALETTE.canopyPillar, { roughness: 0.6, metalness: 0.3 }),
  platformDoor: std(PALETTE.platformDoor, { roughness: 0.5 }),
  platformDoorGlass: new THREE.MeshStandardMaterial({
    color: PALETTE.platformDoorGlass, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.55,
  }),

  rock: std(PALETTE.rock, { flatShading: true, roughness: 1 }),
  rockDark: std(PALETTE.rockDark, { flatShading: true, roughness: 1 }),
  rockSnow: std(PALETTE.rockSnow, { flatShading: true, roughness: 0.95 }),
  grassTerrace: std(PALETTE.grassDark, { roughness: 0.9, flatShading: true }),
  water: new THREE.MeshStandardMaterial({
    color: PALETTE.water, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.85,
  }),
  shore: std(PALETTE.shore, { roughness: 1 }),

  buildingA: std(PALETTE.buildingA, { roughness: 0.9 }),
  buildingB: std(PALETTE.buildingB, { roughness: 0.9 }),
  buildingC: std(PALETTE.buildingC, { roughness: 0.9 }),
  buildingRoof: std(PALETTE.buildingRoof, { roughness: 0.85, flatShading: true }),
  buildingRoofFlat: std(PALETTE.buildingRoofFlat, { roughness: 0.9 }),
  roadAsphalt: std(PALETTE.roadAsphalt, { roughness: 1 }),
  roadKerb: std(PALETTE.roadKerb, { roughness: 1 }),

  foliage: std(PALETTE.foliage, { flatShading: true, roughness: 1 }),
  foliageDark: std(PALETTE.foliageDark, { flatShading: true, roughness: 1 }),
  trunk: std(PALETTE.trunk, { roughness: 1 }),

  carRoof: std(PALETTE.carRoof, { roughness: 0.6 }),
  carWindow: std(PALETTE.carWindow, { roughness: 0.15, metalness: 0.4 }),
  carSkirt: std(PALETTE.carSkirt, { roughness: 0.8 }),
  carBogie: std(PALETTE.carBogie, { roughness: 0.9 }),
  headlight: new THREE.MeshBasicMaterial({ color: PALETTE.headlight }),
  taillight: new THREE.MeshBasicMaterial({ color: PALETTE.taillight }),
} as const;

// 車体色は選択状態で切り替わるためキャッシュして使い回す。
const bodyCache = new Map<string, THREE.MeshStandardMaterial>();
export const bodyMaterial = (color: string): THREE.MeshStandardMaterial => {
  let m = bodyCache.get(color);
  if (!m) {
    m = std(color, { roughness: 0.45, metalness: 0.05 });
    bodyCache.set(color, m);
  }
  return m;
};

// --- 地下ビュー(P8b)用の「暗く半透明」なMATERIALS/bodyMaterialの対になる版。
//
// 地下モードに入ると、選択中の地下レベル以外(地平・高架・別の地下レベル)を
// まとめて暗く半透明にする(design memo「カットアウェイは採用しない」の代わり)。
// セル数・建物数が多い(数百〜数千メッシュ)ため、メッシュごとにマテリアルを
// クローンするのは高コスト。MATERIALSと同じキー構成を持つ「暗い版」を1つずつ
// 生成し、描画側はどちらの共有インスタンスを使うか(dimmed props)を選ぶだけにする。
//
// depthWrite:false と depthTest:false の両方が必須(実測のブラウザ検証で判明した
// バグの修正)。
//   - depthWrite:false が無いと、地表(TerrainBlocks)や地面プレーン(GameScene)の
//     ような「カメラに近い側の半透明メッシュ」が深度バッファへ書き込んでしまい、
//     同じく半透明な他の地表レイヤー(町・樹木・別の地形チャンク)同士が描画順序
//     次第で互いを覆い隠し合う。
//   - depthTest:false も併せて無効化しないと、実機検証で「メッシュはvisible=true・
//     opacity<1で実在するのに画面には一切映らない(地下の線路が完全に隠れる)」
//     不具合が再現した。本アプリのOrthographicCameraはnear=-50という非標準の値を
//     使っており(P8a以前からの既存設定)、これが原因で深度テストの前後判定が
//     直感どおりに働かない現象が起きていたと推測される(scene.traverseで実測:
//     depthTest:trueのままdepthWrite:falseだけにすると地下の不透明メッシュが
//     一切透けて見えず、depthTest:falseに変えた瞬間に正しく透けて見えるように
//     なることをブラウザで確認した)。地表は「常に手前にある半透明の書き割り」
//     という役割なので、深度テストを無効化してもopacity<1が前提で他の不透明物を
//     隠さない設計上、副作用は無い。
const dim = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({
    color, transparent: true, opacity: 0.3, depthWrite: false, depthTest: false, ...extra,
  });

export const DIMMED_MATERIALS = {
  ballast: dim(PALETTE.ballast, { roughness: 1 }),
  sleeper: dim(PALETTE.sleeper, { roughness: 1 }),
  rail: dim(PALETTE.railSteel, { roughness: 0.35, metalness: 0.6 }),
  overpassPier: dim(PALETTE.overpassPier, { roughness: 0.9 }),
  overpassDeck: dim(PALETTE.overpassDeck, { roughness: 0.8, metalness: 0.15 }),

  platform: dim(PALETTE.platform, { roughness: 0.9 }),
  platformSide: dim(PALETTE.platformSide, { roughness: 1 }),
  tactile: dim(PALETTE.tactile, { roughness: 0.8 }),
  canopyRoof: dim(PALETTE.canopyRoof, { roughness: 0.7 }),
  canopyPillar: dim(PALETTE.canopyPillar, { roughness: 0.6, metalness: 0.3 }),
  platformDoor: dim(PALETTE.platformDoor, { roughness: 0.5 }),
  platformDoorGlass: dim(PALETTE.platformDoorGlass, { roughness: 0.1, metalness: 0.1, opacity: 0.14 }),

  rock: dim(PALETTE.rock, { flatShading: true, roughness: 1 }),
  rockDark: dim(PALETTE.rockDark, { flatShading: true, roughness: 1 }),
  rockSnow: dim(PALETTE.rockSnow, { flatShading: true, roughness: 0.95 }),
  grassTerrace: dim(PALETTE.grassDark, { roughness: 0.9, flatShading: true }),
  water: dim(PALETTE.water, { roughness: 0.15, metalness: 0.2, opacity: 0.18 }),
  shore: dim(PALETTE.shore, { roughness: 1 }),

  buildingA: dim(PALETTE.buildingA, { roughness: 0.9 }),
  buildingB: dim(PALETTE.buildingB, { roughness: 0.9 }),
  buildingC: dim(PALETTE.buildingC, { roughness: 0.9 }),
  buildingRoof: dim(PALETTE.buildingRoof, { roughness: 0.85, flatShading: true }),
  buildingRoofFlat: dim(PALETTE.buildingRoofFlat, { roughness: 0.9 }),
  roadAsphalt: dim(PALETTE.roadAsphalt, { roughness: 1 }),
  roadKerb: dim(PALETTE.roadKerb, { roughness: 1 }),

  foliage: dim(PALETTE.foliage, { flatShading: true, roughness: 1 }),
  foliageDark: dim(PALETTE.foliageDark, { flatShading: true, roughness: 1 }),
  trunk: dim(PALETTE.trunk, { roughness: 1 }),

  carRoof: dim(PALETTE.carRoof, { roughness: 0.6 }),
  carWindow: dim(PALETTE.carWindow, { roughness: 0.15, metalness: 0.4 }),
  carSkirt: dim(PALETTE.carSkirt, { roughness: 0.8 }),
  carBogie: dim(PALETTE.carBogie, { roughness: 0.9 }),
  headlight: new THREE.MeshBasicMaterial({ color: PALETTE.headlight, transparent: true, opacity: 0.3 }),
  taillight: new THREE.MeshBasicMaterial({ color: PALETTE.taillight, transparent: true, opacity: 0.3 }),
} as const;

/** dimmedフラグからMATERIALS/DIMMED_MATERIALSどちらの共有セットを使うかを選ぶ。 */
export const materialsFor = (dimmed: boolean): typeof MATERIALS | typeof DIMMED_MATERIALS =>
  dimmed ? DIMMED_MATERIALS : MATERIALS;

const bodyDimmedCache = new Map<string, THREE.MeshStandardMaterial>();
/** bodyMaterialの暗い版(地下ビューで選択中レベル以外の列車に使う)。 */
export const bodyMaterialDimmed = (color: string): THREE.MeshStandardMaterial => {
  let m = bodyDimmedCache.get(color);
  if (!m) {
    m = dim(color, { roughness: 0.45, metalness: 0.05 });
    bodyDimmedCache.set(color, m);
  }
  return m;
};

// --- 共有ジオメトリ ---
export const GEOMETRIES = {
  unitBox: new THREE.BoxGeometry(1, 1, 1),
  unitCylinder: new THREE.CylinderGeometry(1, 1, 1, 10),
} as const;

// 決定的ハッシュ(セル座標→0..1)。装飾物の配置を再現可能にするために使う。
export const hash01 = (x: number, z: number, salt = 0): number => {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};
