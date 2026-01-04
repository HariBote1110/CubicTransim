import React from 'react';
import { DEPOT_COLOUR } from '../types';

interface Props {
  position: [number, number, number];
  rotation?: number;
}

export const DepotBlock: React.FC<Props> = ({ position, rotation = 0 }) => {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* 土台 */}
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[0.9, 0.1, 0.9]} />
        <meshStandardMaterial color="#444" />
      </mesh>
      
      {/* 本体 (コの字型にして入口を作る) */}
      <group position={[0, 0.4, 0]}>
        {/* 屋根 */}
        <mesh position={[0, 0.25, 0]}>
          <boxGeometry args={[0.8, 0.1, 0.9]} />
          <meshStandardMaterial color={DEPOT_COLOUR} />
        </mesh>
        {/* 左壁 */}
        <mesh position={[-0.35, 0, 0]}>
          <boxGeometry args={[0.1, 0.6, 0.9]} />
          <meshStandardMaterial color={DEPOT_COLOUR} />
        </mesh>
        {/* 右壁 */}
        <mesh position={[0.35, 0, 0]}>
          <boxGeometry args={[0.1, 0.6, 0.9]} />
          <meshStandardMaterial color={DEPOT_COLOUR} />
        </mesh>
        {/* 奥壁 (Zプラス側) */}
        <mesh position={[0, 0, 0.4]}>
          <boxGeometry args={[0.8, 0.6, 0.1]} />
          <meshStandardMaterial color={DEPOT_COLOUR} />
        </mesh>
        
        {/* 入口の暗がり (Zマイナス側) */}
        <mesh position={[0, 0, -0.2]}>
          <boxGeometry args={[0.6, 0.5, 0.5]} />
          <meshStandardMaterial color="#111" />
        </mesh>
      </group>
    </group>
  );
};