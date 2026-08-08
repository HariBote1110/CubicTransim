import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { TownData } from '../types';
import type { TerrainField } from '../sim/terrainField';
import { OVERPASS_HEIGHT } from '../sim/trackPath';

interface Props {
  towns: TownData[];
  field: TerrainField;
}

// 人口による色分け(小さい町→大都市)。TownBlocks.tsxの人口しきい値(4000/10000)とは
// 独立の、遠景ドット専用の簡易ティア。
const TIER_COLOURS = ['#8fae6b', '#d9b45c', '#e08a4d', '#c9524f'];
const TIER_THRESHOLDS = [0, 2000, 6000, 12000];

const tierIndexFor = (population: number): number => {
  let idx = 0;
  for (let i = 0; i < TIER_THRESHOLDS.length; i++) {
    if (population >= TIER_THRESHOLDS[i]) idx = i;
  }
  return idx;
};

// 画面上の固定ピクセルサイズ(sizeAttenuation:falseなので距離・zoomに関係なく一定)。
// 全図ズームアウト(pixelsPerCellが1px/セルを大きく下回る)では、ワールド単位の箱では
// サブピクセルに潰れて見えなくなるため、Points(PointsMaterial.sizeAttenuation=false)で
// 「常に画面上で見える大きさ」を確保する。
const MARKER_PIXEL_SIZE = 8;

/**
 * 遠景(WebGPU全図ズームアウト、render/farView.tsのhiddenステージ)専用の町の代替表現。
 *
 * TownBlocksが1町あたり数十〜数百の家・道路メッシュを生成するのに対し、こちらは
 * 町1つにつき頂点1個(色付きの点)だけを使う単一のPointsで、町数(最大1万規模)に対して
 * 線形コストに抑える。頂点バッファはtowns/fieldが変わったときだけ作り直す
 * (毎フレームではない)。R4で町タイルがwgpu側へ移管されるまでの繋ぎ
 * (progress/renderer-integration-plan.md参照)。
 *
 * InstancedMesh(箱)ではなくPointsを使う理由: 全図ズームアウト時のpixelsPerCellは
 * 1px/セルを大きく下回るため、ワールド単位のジオメトリはサイズに関わらず画面上で
 * サブピクセルに潰れて事実上見えなくなる。PointsMaterialのsizeAttenuation:falseは
 * カメラ距離・zoomに関係なく常に指定ピクセル数で描くため、この問題が起きない。
 */
export const TownMarkers: React.FC<Props> = ({ towns, field }) => {
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(towns.length * 3);
    const colours = new Float32Array(towns.length * 3);
    const colourObj = new THREE.Color();
    towns.forEach((town, i) => {
      const groundY = field.cellHeightAt(town.centre.x, town.centre.z) * OVERPASS_HEIGHT;
      positions[i * 3] = town.centre.x;
      positions[i * 3 + 1] = groundY + 0.5;
      positions[i * 3 + 2] = town.centre.z;
      colourObj.set(TIER_COLOURS[tierIndexFor(town.population)]);
      colours[i * 3] = colourObj.r;
      colours[i * 3 + 1] = colourObj.g;
      colours[i * 3 + 2] = colourObj.b;
    });
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    return geo;
  }, [towns, field]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () => new THREE.PointsMaterial({
      size: MARKER_PIXEL_SIZE, sizeAttenuation: false, vertexColors: true, depthTest: false,
    }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  if (towns.length === 0) return null;

  return <points geometry={geometry} material={material} raycast={() => null} frustumCulled={false} />;
};
