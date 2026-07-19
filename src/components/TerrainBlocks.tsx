import React, { useMemo } from 'react';
import type { TerrainType } from '../types';
import { fromKey } from '../utils';

interface Props {
  terrain: Map<string, TerrainType>;
  // トンネル化された山岳セル(rail敷設済み)。ここは山の四角錐を描かず、
  // GameScene側で坑口風のマーカーを別途表示する。
  tunnelKeys?: Set<string>;
}

const WATER_COLOUR = '#3399ee';
const MOUNTAIN_COLOUR = '#888888';

// 地形(水域・山岳)の描画。water は半透明の青いタイル、mountain はグレーの四角錐で表現する。
// セル数が多くなり得るため、Map エントリごとの単純な mesh(数百セル規模なら許容)で描画する。
export const TerrainBlocks: React.FC<Props> = ({ terrain, tunnelKeys }) => {
  const cells = useMemo(
    () => Array.from(terrain.entries()).map(([key, type]) => ({ key, ...fromKey(key), type })),
    [terrain]
  );

  return (
    <>
      {cells.map(cell => {
        const key = cell.key;
        if (cell.type === 'mountain' && tunnelKeys?.has(key)) return null;
        if (cell.type === 'water') {
          return (
            <mesh key={key} position={[cell.x, 0.02, cell.z]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[1, 1]} />
              <meshStandardMaterial color={WATER_COLOUR} transparent opacity={0.6} />
            </mesh>
          );
        }
        // mountain: 高さのある四角錐で山岳を表現する
        return (
          <mesh key={key} position={[cell.x, 0.75, cell.z]}>
            <coneGeometry args={[0.65, 1.5, 4]} />
            <meshStandardMaterial color={MOUNTAIN_COLOUR} />
          </mesh>
        );
      })}
    </>
  );
};
