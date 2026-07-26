import React, { useMemo } from 'react';
import { Html } from '@react-three/drei';
import type { TownData } from '../types';
import { mulberry32 } from '../sim/towns';
import { PALETTE } from '../render/palette';

interface Props {
  towns: TownData[];
}

const TOWN_BLOCK_RADIUS = 3; // 建物群を配置する街半径(タイル)
const BUILDING_COLOURS = [PALETTE.buildingA, PALETTE.buildingB, PALETTE.buildingC];

// 街のidから決定的な数値シードを作る(文字列ハッシュ)。
const seedFromId = (id: string): number => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (Math.imul(31, hash) + id.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
};

// 人口を "2.3k" のような簡易表記に変換する。
const formatPopulation = (population: number): string =>
  population >= 1000 ? `${(population / 1000).toFixed(1)}k` : `${Math.round(population)}`;

interface Building {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  colour: string;
  rotation: number;
  gabled: boolean;
}

const TownBlock: React.FC<{ town: TownData }> = ({ town }) => {
  // 街ごとにidから決定的なシードを作り、建物配置を安定させる。
  const buildings = useMemo<Building[]>(() => {
    const rng = mulberry32(seedFromId(town.id));
    const count = 6 + Math.floor((town.population / 5000) * 10); // 6〜16棟
    const result: Building[] = [];
    for (let i = 0; i < count; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = Math.sqrt(rng()) * TOWN_BLOCK_RADIUS; // 中心寄りに密になるよう平方根で分布
      // 中心に近いほど高い建物が建つ(都心→郊外のシルエット)
      const centreness = 1 - dist / TOWN_BLOCK_RADIUS;
      const tall = rng() < 0.25 + centreness * 0.5;
      result.push({
        x: Math.cos(angle) * dist,
        z: Math.sin(angle) * dist,
        width: 0.32 + rng() * 0.3,
        depth: 0.32 + rng() * 0.3,
        height: tall ? 0.8 + rng() * 1.6 * (0.4 + centreness) : 0.3 + rng() * 0.35,
        colour: BUILDING_COLOURS[Math.floor(rng() * BUILDING_COLOURS.length)],
        rotation: Math.floor(rng() * 4) * (Math.PI / 8),
        gabled: !tall,
      });
    }
    return result;
  }, [town.id, town.population]);

  return (
    <group position={[town.centre.x, 0, town.centre.z]}>
      {buildings.map((b, i) => (
        <group key={i} position={[b.x, 0, b.z]} rotation={[0, b.rotation, 0]}>
          <mesh position={[0, b.height / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[b.width, b.height, b.depth]} />
            <meshStandardMaterial color={b.colour} roughness={0.9} />
          </mesh>
          {b.gabled ? (
            // 低層の住宅には寄棟屋根を載せる
            <mesh position={[0, b.height + 0.08, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
              <coneGeometry args={[Math.max(b.width, b.depth) * 0.78, 0.18, 4]} />
              <meshStandardMaterial color={PALETTE.buildingRoof} roughness={0.85} flatShading />
            </mesh>
          ) : (
            // 高層はパラペットと屋上設備で「ビル」らしく
            <>
              <mesh position={[0, b.height + 0.02, 0]}>
                <boxGeometry args={[b.width + 0.03, 0.04, b.depth + 0.03]} />
                <meshStandardMaterial color="#9a958c" roughness={0.9} />
              </mesh>
              <mesh position={[0, b.height + 0.09, 0]}>
                <boxGeometry args={[b.width * 0.4, 0.1, b.depth * 0.4]} />
                <meshStandardMaterial color="#8e8a82" roughness={0.9} />
              </mesh>
            </>
          )}
        </group>
      ))}

      <Html position={[0, 2.6, 0]} center style={{ pointerEvents: 'none' }}>
        <div style={{
          background: 'rgba(24,30,38,0.62)', color: '#f2f5f8', padding: '2px 7px',
          borderRadius: '999px', fontSize: '10px', whiteSpace: 'nowrap',
          backdropFilter: 'blur(3px)', border: '1px solid rgba(255,255,255,0.14)',
        }}>
          {formatPopulation(town.population)}
        </div>
      </Html>
    </group>
  );
};

export const TownBlocks: React.FC<Props> = ({ towns }) => (
  <>{towns.map(town => <TownBlock key={town.id} town={town} />)}</>
);
