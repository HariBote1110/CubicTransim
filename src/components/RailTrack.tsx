import React, { useMemo } from 'react';
import * as THREE from 'three';
import { RAIL_COLOUR } from '../types';

interface RailTrackProps {
  points: THREE.Vector3[];
}

/**
 * レール描画コンポーネント
 * pointsで指定された座標を通る滑らかなラインを描画します。
 */
export const RailTrack: React.FC<RailTrackProps> = ({ points }) => {
  // CatmullRomCurve3を使って、点と点を滑らかに繋ぐ曲線を生成
  const curve = useMemo(() => {
    return new THREE.CatmullRomCurve3(points, true); // true = 閉じたループ
  }, [points]);

  const linePoints = useMemo(() => curve.getPoints(100), [curve]);

  return (
    <line>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={linePoints.length}
          array={new Float32Array(linePoints.flatMap(p => [p.x, p.y + 0.1, p.z]))} // 地面より少し浮かす
          itemSize={3}
        />
      </bufferGeometry>
      <lineBasicMaterial color={RAIL_COLOUR} linewidth={2} />
    </line>
  );
};