// タイルベースの町(家・道路)のジオメトリ生成。描画専任レイヤーの純粋な部品で、
// three.js(TownBlocks.tsx)と wgpu(WebGpuTownBlocks.tsx)の両方から同じ関数を呼ぶ。
//
// sim/townTiles.tsが決めたサブタイル(1ゲームタイルを2x2分割、一辺0.5)の中央に建てる。
// 道路は幅0.5の帯になり、1タイル幅の線路より明確に細く、家は道路沿いに並ぶ小さな建物になる。
// 家の大きさ・高さ・色はサブタイル座標のハッシュから決定的に散らす。

import * as THREE from 'three';
import type { TownData } from '../types';
import { fromKey } from '../utils';
import type { TownSubTileIndex } from '../sim/townTiles';
import { subTileWorldCentre, townSubTileRadius, SUB_TILES_PER_TILE, parentTileOfSub } from '../sim/townTiles';
import { hash01 } from './palette';
import { mergeAndDispose } from './mergeGeometry';
import type { TerrainField } from '../sim/terrainField';
import { OVERPASS_HEIGHT } from '../sim/trackPath';

/** この人口以上の町には、一部のサブタイルに高層ビルが混ざる。 */
const TALL_BUILDING_POPULATION = 4000;
/** この人口以上の町は「都心コア(高層)・中層リング・郊外(低層)」の同心円構造になる。 */
const CITY_CORE_POPULATION = 10000;
/** 正規化距離(中心からのチェビシェフ距離 / 町サブタイル半径)による同心円の境界。 */
const CITY_CORE_RADIUS_RATIO = 0.35;
const CITY_MIDRISE_RADIUS_RATIO = 0.7;

export interface TownGeometries {
  wallsA: THREE.BufferGeometry | null;
  wallsB: THREE.BufferGeometry | null;
  wallsC: THREE.BufferGeometry | null;
  roofs: THREE.BufferGeometry | null;
  roofsFlat: THREE.BufferGeometry | null;
  roads: THREE.BufferGeometry | null;
  kerbs: THREE.BufferGeometry | null;
}

/**
 * サブタイル索引から町の建物・道路ジオメトリを組み立てる(マテリアル別に7バケット)。
 *
 * 道路サブタイルは地平の線路と同居できる(踏切)。その場合も路面スラブは描いたままに
 * することで、線路が路面を横切る見た目(簡易的な踏切)になる。
 */
export function buildTownGeometries(
  towns: readonly TownData[],
  townSubTiles: TownSubTileIndex,
  field: TerrainField,
): TownGeometries {
  const townById = new Map(towns.map(t => [t.id, t]));
  const wallsA: THREE.BufferGeometry[] = [];
  const wallsB: THREE.BufferGeometry[] = [];
  const wallsC: THREE.BufferGeometry[] = [];
  const roofs: THREE.BufferGeometry[] = [];
  const roofsFlat: THREE.BufferGeometry[] = [];
  const roads: THREE.BufferGeometry[] = [];
  const kerbs: THREE.BufferGeometry[] = [];

  for (const [key, entry] of townSubTiles) {
    const { x: sx, z: sz } = fromKey(key);
    const wx = subTileWorldCentre(sx);
    const wz = subTileWorldCentre(sz);
    // P7d: サブタイルは親タイルを跨がない(sim/townTiles.ts)ので、親タイルの標高
    // (flat限定なのでcellHeightAtで一意に決まる)ぶんだけ丸ごと持ち上げれば足りる。
    const wy = field.cellHeightAt(parentTileOfSub(sx), parentTileOfSub(sz)) * OVERPASS_HEIGHT;

    if (entry.kind === 'road') {
      // 縁石(サブタイル全面のわずかに明るい下地)+アスファルトの路面スラブ。
      // 隣接する道路サブタイル同士はスラブが繋がって幅0.5の帯になる。
      const kerb = new THREE.BoxGeometry(0.5, 0.03, 0.5);
      kerb.translate(wx, wy + 0.015, wz);
      kerbs.push(kerb);
      const slab = new THREE.BoxGeometry(0.44, 0.045, 0.44);
      slab.translate(wx, wy + 0.0225, wz);
      roads.push(slab);
      continue;
    }

    // 家: サブタイル座標ハッシュで大きさ・高さ・色を決定的に散らす。
    // 一辺0.5のサブタイルに収まる 0.30..0.42 の足元。
    const town = townById.get(entry.townId);
    const population = town?.population ?? 0;
    const width = 0.3 + hash01(sx, sz, 21) * 0.12;
    const depth = 0.3 + hash01(sx, sz, 22) * 0.12;

    // 都市の高さ分布: 人口CITY_CORE_POPULATION以上の町は、中心からの正規化距離で
    // 「高層コア→中層リング→低層の郊外」の同心円になる(すべてハッシュ由来で決定的)。
    // それ未満の町は従来通り、TALL_BUILDING_POPULATION以上で12%の高層のみ。
    let tall = false;
    let midRise = false;
    let coreTower = false;
    if (population >= CITY_CORE_POPULATION && town) {
      const subRadius = townSubTileRadius(population);
      const d =
        Math.max(
          Math.abs(sx - town.centre.x * SUB_TILES_PER_TILE),
          Math.abs(sz - town.centre.z * SUB_TILES_PER_TILE)
        ) / subRadius;
      if (d <= CITY_CORE_RADIUS_RATIO) {
        tall = hash01(sx, sz, 25) < 0.55;
        coreTower = tall;
      } else if (d <= CITY_MIDRISE_RADIUS_RATIO) {
        tall = hash01(sx, sz, 25) < 0.12;
        midRise = !tall && hash01(sx, sz, 27) < 0.45;
      } else {
        tall = hash01(sx, sz, 25) < 0.04;
      }
    } else if (population >= TALL_BUILDING_POPULATION) {
      tall = hash01(sx, sz, 25) < 0.12;
    }
    const height = coreTower
      ? 1.2 + hash01(sx, sz, 26) * 1.8
      : tall
        ? 0.9 + hash01(sx, sz, 26) * 1.2
        : midRise
          ? 0.5 + hash01(sx, sz, 26) * 0.6
          : 0.24 + hash01(sx, sz, 26) * 0.28;

    const wall = new THREE.BoxGeometry(width, height, depth);
    wall.translate(wx, wy + height / 2, wz);
    const bucket = hash01(sx, sz, 23);
    (bucket < 0.34 ? wallsA : bucket < 0.67 ? wallsB : wallsC).push(wall);

    if (tall || midRise) {
      // 高層・中層はパラペット(平屋根)で「ビル」らしく。
      const parapet = new THREE.BoxGeometry(width + 0.03, 0.04, depth + 0.03);
      parapet.translate(wx, wy + height + 0.02, wz);
      roofsFlat.push(parapet);
      const plant = new THREE.BoxGeometry(width * 0.4, 0.07, depth * 0.4);
      plant.translate(wx, wy + height + 0.07, wz);
      roofsFlat.push(plant);
    } else {
      // 低層の住宅には寄棟屋根を載せる。
      const roof = new THREE.ConeGeometry(Math.max(width, depth) * 0.8, 0.15, 4);
      roof.rotateY(Math.PI / 4);
      roof.translate(wx, wy + height + 0.075, wz);
      roofs.push(roof);
    }
  }

  return {
    wallsA: mergeAndDispose(wallsA),
    wallsB: mergeAndDispose(wallsB),
    wallsC: mergeAndDispose(wallsC),
    roofs: mergeAndDispose(roofs),
    roofsFlat: mergeAndDispose(roofsFlat),
    roads: mergeAndDispose(roads),
    kerbs: mergeAndDispose(kerbs),
  };
}

/** 人口を "2.3k" のような簡易表記に変換する(町ラベル用)。 */
export const formatPopulation = (population: number): string =>
  population >= 1000 ? `${(population / 1000).toFixed(1)}k` : `${Math.round(population)}`;
