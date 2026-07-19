import React, { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { TRAIN_COLOUR, SELECTED_TRAIN_COLOUR } from '../types';
import type { TrainType, TrainData } from '../types';
import type { TrainRuntime } from '../sim/simulation';

interface DynamicTrainProps {
  data: TrainData;
  runtimes: Map<string, TrainRuntime>;
  type: TrainType;
  isSelected: boolean;
  onClick: (e: any) => void;
}

export const DynamicTrain: React.FC<DynamicTrainProps> = ({
  data, runtimes, type, isSelected, onClick
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const carRefs = useRef<(THREE.Group | null)[]>([]);
  const speedTextRef = useRef<HTMLDivElement>(null);
  const statusTextRef = useRef<HTMLDivElement>(null);

  // 選択中の経路スフィア表示のみ低頻度に再レンダリングする
  const [displayRoute, setDisplayRoute] = useState<{ x: number; z: number }[]>([]);

  useFrame(() => {
    const runtime = runtimes.get(data.id);
    if (!runtime || !groupRef.current) return;

    groupRef.current.position.set(runtime.renderPos.x, runtime.renderPos.y, runtime.renderPos.z);
    if (runtime.renderTarget) {
      groupRef.current.lookAt(runtime.renderTarget.x, runtime.renderTarget.y, runtime.renderTarget.z);
    }

    // 2両目以降: runtime.trail(先頭が現在セル)に沿って1タイル間隔で後方配置する。
    // 発車直後などtrail長がcarsに満たない間は先頭セルに重ねて描画する(仕様どおり)。
    for (let i = 1; i < carRefs.current.length; i++) {
      const carGroup = carRefs.current[i];
      if (!carGroup) continue;
      const trailCell = runtime.trail[i] ?? runtime.trail[runtime.trail.length - 1] ?? runtime.grid;
      const prevCell = runtime.trail[i - 1] ?? runtime.grid;
      carGroup.position.set(trailCell.x, 0.5, trailCell.z);
      const lookAtTarget = prevCell;
      carGroup.lookAt(lookAtTarget.x, 0.5, lookAtTarget.z);
    }

    if (isSelected) {
      if (speedTextRef.current) speedTextRef.current.textContent = `${Math.round(runtime.speedKmh)} km/h`;
      if (statusTextRef.current) statusTextRef.current.textContent = runtime.debugStatus;
      setDisplayRoute(runtime.route);
    }
  });

  if (data.status === 'stored') return null;

  const color = isSelected ? SELECTED_TRAIN_COLOUR : TRAIN_COLOUR;
  const trailingCars = Math.max(0, data.cars - 1);

  const carBody = (
    <>
      {type === 'commuter' ? (
        <mesh>
          <boxGeometry args={[0.8, 0.8, 1.6]} />
          <meshStandardMaterial color={color} />
        </mesh>
      ) : (
        <group>
          <mesh position={[0, 0, 0.2]}>
            <boxGeometry args={[0.7, 0.7, 1.8]} />
            <meshStandardMaterial color={color} />
          </mesh>
          <mesh position={[0, 0, 1.3]} rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.35, 0.8, 4]} />
            <meshStandardMaterial color={color} />
          </mesh>
        </group>
      )}
    </>
  );

  return (
    <group>
      {/* 2両目以降(後続車両)。先頭より落ち着いた色にして見分けが付くようにする。 */}
      {Array.from({ length: trailingCars }).map((_, idx) => (
        <group key={`car-${idx}`} ref={el => { carRefs.current[idx + 1] = el; }}>
          <mesh>
            <boxGeometry args={[0.8, 0.8, 1.6]} />
            <meshStandardMaterial color="#8899aa" />
          </mesh>
        </group>
      ))}

      <group ref={(el) => { groupRef.current = el; carRefs.current[0] = el; }} position={[data.x, 0.5, data.z]} onClick={(e) => { e.stopPropagation(); onClick(e); }}>
        {carBody}
        {isSelected && (
          <mesh position={[0, 1.5, 0]}>
            <coneGeometry args={[0.2, 0.5, 4]} />
            <meshBasicMaterial color={SELECTED_TRAIN_COLOUR} />
          </mesh>
        )}

        {isSelected && (
          <Html position={[0, 2.5, 0]} center style={{ pointerEvents: 'none', width: '200px', textAlign: 'center' }}>
            <div style={{
              background: 'rgba(0,0,0,0.8)', color: 'white', padding: '4px 8px',
              borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace',
              border: '1px solid #666'
            }}>
              <div>{data.id}</div>
              <div ref={speedTextRef} style={{ color: '#aaffaa', fontWeight: 'bold' }} />
              <div ref={statusTextRef} style={{ color: '#ccc' }} />
            </div>
          </Html>
        )}
      </group>

      {isSelected && displayRoute.map((pos, i) => (
        <mesh key={`route-${i}`} position={[pos.x, 0.5, pos.z]}>
          <sphereGeometry args={[0.08]} />
          <meshBasicMaterial color="#ffff00" transparent opacity={0.3} />
        </mesh>
      ))}
    </group>
  );
};
