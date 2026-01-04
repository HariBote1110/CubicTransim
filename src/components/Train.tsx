import React, { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { TRAIN_COLOUR } from '../types';
import type { TrainProps } from '../types';

/**
 * 電車コンポーネント
 */
export const Train: React.FC<TrainProps> = ({ type, route, speed = 0.5, startOffset = 0 }) => {
  const groupRef = useRef<THREE.Group>(null);
  
  // 進行状況 (0.0 から 1.0 のループ)
  const [progress, setProgress] = useState(startOffset);

  // ルート情報のメモ化
  const curve = useMemo(() => {
    return new THREE.CatmullRomCurve3(route, true); 
  }, [route]);

  useFrame((_state, delta) => {
    if (!groupRef.current) return;

    // 速度に基づいて進行度を更新
    const newProgress = (progress + (speed * delta * 0.1)) % 1.0;
    setProgress(newProgress);

    // 現在位置の取得
    const position = curve.getPointAt(newProgress);
    
    // 少し先の位置を取得して、向き（回転）を計算する
    const lookAtPosition = curve.getPointAt((newProgress + 0.01) % 1.0);

    // 位置を適用 (Y軸は車両の高さの半分浮かす)
    groupRef.current.position.set(position.x, position.y + 0.5, position.z);
    
    // 向きを適用
    groupRef.current.lookAt(lookAtPosition.x, lookAtPosition.y + 0.5, lookAtPosition.z);
  });

  return (
    <group ref={groupRef}>
      {/* 車両タイプによる形状の出し分け */}
      {type === 'commuter' ? (
        // Commuter: シンプルな直方体
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[0.8, 0.8, 1.8]} />
          <meshStandardMaterial color={TRAIN_COLOUR} />
        </mesh>
      ) : (
        // Express: 少し長く、先頭にノーズがある形状
        <group>
          {/* ボディ */}
          <mesh position={[0, 0, 0.2]}>
            <boxGeometry args={[0.7, 0.7, 2.0]} />
            <meshStandardMaterial color={TRAIN_COLOUR} />
          </mesh>
          {/* ノーズ */}
          <mesh position={[0, 0, 1.4]} rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.35, 0.8, 4]} />
            <meshStandardMaterial color={TRAIN_COLOUR} />
          </mesh>
        </group>
      )}
    </group>
  );
};