// 描画専用のカラーパレット。
//
// 方針: 「Nゲージのジオラマ」を目標にしたローポリ表現。彩度を抑えた自然色を基調に、
// ホームの黄色い点字ブロックや車両の帯だけを彩度の高いアクセントにして視線を集める。
// sim層からは一切参照しない(描画専任レイヤー)。
//
// R4d(three.js 退役)で共有マテリアル(MATERIALS/DIMMED_MATERIALS/materialsFor/
// bodyMaterial/GEOMETRIES)は削除した。wgpu は頂点色だけで描くため、色は
// render/bakedMesh.ts が PALETTE の16進値をそのまま焼き込む。

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
  // R4末: 山岳トンネル坑口(ヘッドウォール)と色調を揃え、開口全体が「暗い穴+
  // コンクリート擁壁」の掘割として一貫して見えるようにした(以前は擁壁も穴と
  // 同じほぼ黒色で焼いていたため、擁壁の存在が視認できず「ただの黒い平面」に
  // 見えていた)。
  undergroundPit: '#0b0e12',
  undergroundWall: '#8b9097',

  // --- 架線(electrified区間、PM2 follow-up) ---
  catenaryMast: '#4a4d52',
  catenaryWire: '#2e3033',
  // PM3: 交流区間はわずかに青みがかった色調にして、直流(上記グレー)との境界が
  // 目視で分かるようにする(design decision 5、デッドセクション自体の専用表現はスコープ外)。
  catenaryMastAc: '#454b5a',
  catenaryWireAc: '#28303e',

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
  // PM4: 変電所(変圧器の箱・碍子・ボディ)。車庫と混同しないよう黄系のアクセントにする。
  substationBody: '#6b6f78',
  substationTransformer: '#c9a227',
  substationInsulator: '#e8e2d0',
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

export const hash01 = (x: number, z: number, salt = 0): number => {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};
