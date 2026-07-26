import React from 'react';
import { PALETTE } from '../render/palette';

interface Props {
  position: [number, number, number];
  rotation?: number;
}

/**
 * 車庫(検車区)の描画。
 *
 * コの字の箱だったものを、コンクリート土台・妻面のシャッター開口・
 * 片流れ屋根・軒下の梁を持つ車両基地らしい造形に作り直した。
 * ローカル -Z 側が入口(線路が入ってくる側)。
 */
export const DepotBlock: React.FC<Props> = ({ position, rotation = 0 }) => (
  <group position={position} rotation={[0, rotation, 0]}>
    {/* 土台(コンクリート床) */}
    <mesh position={[0, 0.04, 0]} receiveShadow>
      <boxGeometry args={[0.96, 0.08, 0.96]} />
      <meshStandardMaterial color="#9a978f" roughness={1} />
    </mesh>
    {/* 庫内の線路(入口から奥へ) */}
    {[-0.125, 0.125].map(x => (
      <mesh key={x} position={[x, 0.11, 0]}>
        <boxGeometry args={[0.045, 0.05, 0.9]} />
        <meshStandardMaterial color={PALETTE.railSteel} roughness={0.35} metalness={0.6} />
      </mesh>
    ))}

    {/* 側壁 */}
    {[-1, 1].map(side => (
      <mesh key={side} position={[side * 0.42, 0.36, 0.03]} castShadow receiveShadow>
        <boxGeometry args={[0.08, 0.62, 0.9]} />
        <meshStandardMaterial color={PALETTE.depotWall} roughness={0.85} />
      </mesh>
    ))}
    {/* 奥の妻壁 */}
    <mesh position={[0, 0.36, 0.44]} castShadow>
      <boxGeometry args={[0.92, 0.62, 0.08]} />
      <meshStandardMaterial color={PALETTE.depotWall} roughness={0.85} />
    </mesh>
    {/* 入口側の垂れ壁(シャッターの上端。開口を残して車両が入れるようにする) */}
    <mesh position={[0, 0.62, -0.44]} castShadow>
      <boxGeometry args={[0.92, 0.12, 0.08]} />
      <meshStandardMaterial color={PALETTE.depotWall} roughness={0.85} />
    </mesh>
    {/* 開口の暗がり */}
    <mesh position={[0, 0.3, -0.42]}>
      <boxGeometry args={[0.7, 0.5, 0.02]} />
      <meshStandardMaterial color="#161b21" roughness={1} />
    </mesh>

    {/* 片流れ屋根(入口側が低い) */}
    <mesh position={[0, 0.71, 0]} rotation={[-0.06, 0, 0]} castShadow>
      <boxGeometry args={[1.02, 0.06, 1.02]} />
      <meshStandardMaterial color={PALETTE.depotRoof} roughness={0.8} />
    </mesh>
  </group>
);
