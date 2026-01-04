import React from 'react';
import { SIGNAL_COLOUR } from '../types';

interface Props {
  position: [number, number, number];
  dir: number; // DIR.N, DIR.E ...
}

export const SignalBlock: React.FC<Props> = ({ position, dir }) => {
  // DIRビットからY軸回転角度を求める
  let rotation = 0;
  // utils.ts の DIR 定義に基づく (N=0b10000000, etc)
  // 簡易的に変換
  if (dir & 0b10000000) rotation = 0;          // N
  else if (dir & 0b01000000) rotation = -Math.PI/4; // NE
  else if (dir & 0b00100000) rotation = -Math.PI/2; // E
  else if (dir & 0b00010000) rotation = -3*Math.PI/4; // SE
  else if (dir & 0b00001000) rotation = Math.PI;    // S
  else if (dir & 0b00000100) rotation = 3*Math.PI/4; // SW
  else if (dir & 0b00000010) rotation = Math.PI/2;  // W
  else if (dir & 0b00000001) rotation = Math.PI/4;  // NW

  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* ポール */}
      <mesh position={[0.3, 0.25, 0]}>
        <cylinderGeometry args={[0.03, 0.03, 0.5]} />
        <meshStandardMaterial color="#333" />
      </mesh>
      
      {/* 信号機本体 */}
      <mesh position={[0.3, 0.4, 0]}>
        <boxGeometry args={[0.1, 0.2, 0.1]} />
        <meshStandardMaterial color="#222" />
      </mesh>
      
      {/* ライト (緑) - 進行方向を向いている */}
      <mesh position={[0.3, 0.42, -0.06]}>
        <cylinderGeometry args={[0.03, 0.03, 0.02]} rotation={[Math.PI/2, 0, 0]} />
        <meshBasicMaterial color="#00ff00" />
      </mesh>
      {/* ライト (赤) - 裏側は進入禁止イメージ */}
      <mesh position={[0.3, 0.35, 0.06]}>
        <cylinderGeometry args={[0.03, 0.03, 0.02]} rotation={[Math.PI/2, 0, 0]} />
        <meshBasicMaterial color="#ff0000" />
      </mesh>

      {/* 矢印 (地面) */}
      <mesh position={[0, 0.02, -0.2]} rotation={[-Math.PI/2, 0, 0]}>
        <coneGeometry args={[0.1, 0.2, 3]} />
        <meshBasicMaterial color={SIGNAL_COLOUR} transparent opacity={0.8} />
      </mesh>
    </group>
  );
};