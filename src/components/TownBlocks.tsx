import React, { useMemo } from 'react';
import { Html } from '@react-three/drei';
import type { TownData } from '../types';
import { mulberry32 } from '../sim/towns';

interface Props {
  towns: TownData[];
}

const TOWN_COLOUR = '#888888';
const TOWN_COLOUR_DARK = '#666666';
const TOWN_BLOCK_RADIUS = 3; // 建物群を配置する街半径(タイル)

// 街のidから決定的な数値シードを作る(文字列ハッシュ)。
const seedFromId = (id: string): number => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (Math.imul(31, hash) + id.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
};

// 人口を "2.3k" のような簡易表記に変換する。
const formatPopulation = (population: number): string => {
  if (population >= 1000) {
    return `${(population / 1000).toFixed(1)}k`;
  }
  return `${Math.round(population)}`;
};

const TownBlock: React.FC<{ town: TownData }> = ({ town }) => {
  // 街ごとにidから決定的なシードを作り、建物配置を安定させる。
  const buildings = useMemo(() => {
    const rng = mulberry32(seedFromId(town.id));
    const buildingCount = 3 + Math.floor((town.population / 5000) * 7); // 3〜10個
    const result: { x: number; z: number; height: number }[] = [];
    for (let i = 0; i < buildingCount; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = rng() * TOWN_BLOCK_RADIUS;
      result.push({
        x: Math.cos(angle) * dist,
        z: Math.sin(angle) * dist,
        height: 0.5 + rng() * 1.5,
      });
    }
    return result;
  }, [town.id, town.population]);

  return (
    <group position={[town.centre.x, 0, town.centre.z]}>
      {/* 中心の大きめの建物 */}
      <mesh position={[0, 1, 0]}>
        <boxGeometry args={[1.2, 2, 1.2]} />
        <meshStandardMaterial color={TOWN_COLOUR_DARK} />
      </mesh>

      {/* 周辺の小さな建物群 */}
      {buildings.map((b, i) => (
        <mesh key={i} position={[b.x, b.height / 2, b.z]}>
          <boxGeometry args={[0.6, b.height, 0.6]} />
          <meshStandardMaterial color={TOWN_COLOUR} />
        </mesh>
      ))}

      <Html position={[0, 2.5, 0]} center style={{ pointerEvents: 'none' }}>
        <div style={{
          background: 'rgba(0,0,0,0.6)', color: 'white', padding: '2px 6px',
          borderRadius: '4px', fontSize: '10px', whiteSpace: 'nowrap', backdropFilter: 'blur(2px)'
        }}>
          {formatPopulation(town.population)}
        </div>
      </Html>
    </group>
  );
};

export const TownBlocks: React.FC<Props> = ({ towns }) => {
  return (
    <>
      {towns.map(town => <TownBlock key={town.id} town={town} />)}
    </>
  );
};
