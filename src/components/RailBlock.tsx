import React, { useMemo } from 'react';
import * as THREE from 'three';
import { RAIL_COLOUR } from '../types';
import { DIR } from '../utils';

// --- 定数設定 ---
const RAIL_WIDTH = 0.05;
const RAIL_HEIGHT = 0.05;
const RAIL_SPACING = 0.25;

// 共通マテリアル
const railMaterial = new THREE.MeshStandardMaterial({ color: RAIL_COLOUR });

// 各方向ビットに対応する「セル中心→隣接セルとの境界点」までのベクトル。
// 上下左右(カーディナル)は辺の中点(距離0.5)、斜めは隣接セルと接する角(距離√2/2)になる。
// どちらも隣接セル側から見て全く同じ境界点を指すため、接続の組み合わせによらず
// セル間で線路が途切れない。
const BOUNDARY_OFFSETS: { bit: number; x: number; z: number }[] = [
  { bit: DIR.N, x: 0, z: -0.5 },
  { bit: DIR.NE, x: 0.5, z: -0.5 },
  { bit: DIR.E, x: 0.5, z: 0 },
  { bit: DIR.SE, x: 0.5, z: 0.5 },
  { bit: DIR.S, x: 0, z: 0.5 },
  { bit: DIR.SW, x: -0.5, z: 0.5 },
  { bit: DIR.W, x: -0.5, z: 0 },
  { bit: DIR.NW, x: -0.5, z: -0.5 },
];

/**
 * 「セル中心 → 境界点」の1本のレール区間 (2本のレールを進行方向に垂直に±オフセットして描く)
 */
const CentreToBoundaryPart: React.FC<{ bx: number; bz: number }> = ({ bx, bz }) => {
  const length = Math.sqrt(bx * bx + bz * bz);
  const ux = bx / length;
  const uz = bz / length;
  // three.js の rotateY(theta) は local +Z 軸を world (sin theta, 0, cos theta) へ写すため、
  // 方向ベクトル(ux,uz)に一致する theta は atan2(ux, uz)。
  const rotation = Math.atan2(ux, uz);

  return (
    <group position={[bx / 2, 0, bz / 2]} rotation={[0, rotation, 0]}>
      <mesh position={[-RAIL_SPACING / 2, 0, 0]} material={railMaterial}>
        <boxGeometry args={[RAIL_WIDTH, RAIL_HEIGHT, length]} />
      </mesh>
      <mesh position={[RAIL_SPACING / 2, 0, 0]} material={railMaterial}>
        <boxGeometry args={[RAIL_WIDTH, RAIL_HEIGHT, length]} />
      </mesh>
    </group>
  );
};

/**
 * 何も接続がない場合(建設プレビュー中など)のフォールバック: 縦直線1本分
 */
const StraightPreviewPart: React.FC = () => (
  <group>
    <mesh position={[-RAIL_SPACING / 2, 0, 0]} material={railMaterial}>
      <boxGeometry args={[RAIL_WIDTH, RAIL_HEIGHT, 1.0]} />
    </mesh>
    <mesh position={[RAIL_SPACING / 2, 0, 0]} material={railMaterial}>
      <boxGeometry args={[RAIL_WIDTH, RAIL_HEIGHT, 1.0]} />
    </mesh>
  </group>
);

interface RailBlockProps {
  position: [number, number, number];
  connections?: number;
  isPreview?: boolean;
}

/**
 * レール描画コンポーネント
 *
 * 各接続方向ビットについて「セル中心→その方向の辺(または角)の中点」までレールを
 * 2本描く。境界点は隣接セルの描画と厳密に一致するため、直線・カーブ・分岐など
 * どんな接続の組み合わせでもセル間で線路が途切れない。中心では各方向のセグメントが
 * 重なって小さな継ぎ目が出るため、目立たなくする短い円柱を中心に置く。
 */
export const RailBlock: React.FC<RailBlockProps> = ({ position, connections = 0, isPreview = false }) => {
  const railY = position[1] + RAIL_HEIGHT / 2;

  const RailParts = useMemo(() => {
    if (connections === 0) {
      return <StraightPreviewPart />;
    }

    const parts: React.JSX.Element[] = [];
    for (const { bit, x, z } of BOUNDARY_OFFSETS) {
      if (connections & bit) {
        parts.push(<CentreToBoundaryPart key={bit} bx={x} bz={z} />);
      }
    }

    // 中心の継ぎ目を隠すための小さな接合ジオメトリ(短い縦円柱)
    parts.push(
      <mesh key="joint" position={[0, 0, 0]} material={railMaterial}>
        <cylinderGeometry args={[RAIL_SPACING / 2 + RAIL_WIDTH, RAIL_SPACING / 2 + RAIL_WIDTH, RAIL_HEIGHT, 12]} />
      </mesh>
    );

    return <group>{parts}</group>;
  }, [connections]);

  return (
    <group position={[position[0], railY, position[2]]}>
      {RailParts}
      {/* プレビュー時のハイライト */}
      {isPreview && (
         <mesh position={[0,0,0]}>
           <boxGeometry args={[0.9, 0.1, 0.9]} />
           <meshBasicMaterial color="#00aaff" transparent opacity={0.3} depthWrite={false} />
         </mesh>
      )}
    </group>
  );
};
