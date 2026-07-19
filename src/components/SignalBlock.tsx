import React from 'react';
import { SIGNAL_COLOUR } from '../types';
import { getVectorFromDir } from '../utils';

interface Props {
  position: [number, number, number];
  dir: number; // DIR.N, DIR.E ...
}

const CHEVRON_COLOUR = '#ffcc00';

/**
 * 信号機の描画コンポーネント
 *
 * 許可方向(signalDir)を示す平たい矢印(chevron)を線路脇に置き、支柱＋灯器(緑)を添える。
 * 矢印・支柱・灯器はすべて同じgroupに属し、そのgroupをsignalDirの向きへY軸回転させる
 * ことで、どの8方向でも遠目から一目で許可方向がわかるようにする。
 */
export const SignalBlock: React.FC<Props> = ({ position, dir }) => {
  const v = getVectorFromDir(dir);
  // three.jsのrotateY(theta)はローカル+Z軸をワールド(sin theta, 0, cos theta)へ写すため、
  // 方向ベクトル(v.x, v.z)に一致するthetaはatan2(v.x, v.z)。RailBlockと同じ規約。
  const rotation = Math.atan2(v.x, v.z);

  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* 支柱 (線路脇に少しオフセット) */}
      <mesh position={[0.3, 0.25, 0]}>
        <cylinderGeometry args={[0.03, 0.03, 0.5]} />
        <meshStandardMaterial color="#333" />
      </mesh>

      {/* 信号機本体 */}
      <mesh position={[0.3, 0.42, 0]}>
        <boxGeometry args={[0.12, 0.16, 0.12]} />
        <meshStandardMaterial color="#222" />
      </mesh>

      {/* ライト (緑) - 許可方向(local +Z, 進行方向)を向いている */}
      <mesh position={[0.3, 0.42, 0.07]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.035, 0.035, 0.02]} />
        <meshBasicMaterial color="#00ff00" />
      </mesh>

      {/* 平たい矢印(chevron): 地面に置き、許可方向(local +Z)を指す。
          遠目でも向きが分かるよう、軸(shaft)+く字形の矢羽根(head)で構成する。 */}
      <group position={[0, 0.03, 0]}>
        {/* 軸 */}
        <mesh position={[0, 0, -0.05]}>
          <boxGeometry args={[0.08, 0.02, 0.5]} />
          <meshBasicMaterial color={CHEVRON_COLOUR} />
        </mesh>
        {/* 矢羽根 左 */}
        <mesh position={[-0.09, 0, 0.18]} rotation={[0, Math.PI / 5, 0]}>
          <boxGeometry args={[0.08, 0.025, 0.3]} />
          <meshBasicMaterial color={CHEVRON_COLOUR} />
        </mesh>
        {/* 矢羽根 右 */}
        <mesh position={[0.09, 0, 0.18]} rotation={[0, -Math.PI / 5, 0]}>
          <boxGeometry args={[0.08, 0.025, 0.3]} />
          <meshBasicMaterial color={CHEVRON_COLOUR} />
        </mesh>
      </group>

      {/* 地面のマーカー(禁止方向を示す小さな点、信号色を踏襲) */}
      <mesh position={[0, 0.021, -0.35]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.06, 8]} />
        <meshBasicMaterial color={SIGNAL_COLOUR} transparent opacity={0.6} />
      </mesh>
    </group>
  );
};
