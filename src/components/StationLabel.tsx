import React, { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { StationData } from '../types';
import type { SimWorld } from '../sim/simulation';

interface Props {
  station: StationData;
  orderIndices: number[]; // 変更: 複数の番号を受け取る配列
  world: React.RefObject<SimWorld>;
}

// 待ち人数の更新頻度(秒)。sim層のwaitingは毎tick更新されるが、
// 表示はDynamicTrainの速度表示と同様に低頻度のsetStateで十分。
const WAITING_DISPLAY_INTERVAL = 0.5;

export const StationLabel: React.FC<Props> = ({ station, orderIndices, world }) => {
  const [waitingCount, setWaitingCount] = useState(0);
  const elapsedRef = useRef(0);

  useFrame((_state, delta) => {
    elapsedRef.current += delta;
    if (elapsedRef.current < WAITING_DISPLAY_INTERVAL) return;
    elapsedRef.current = 0;
    const waiting = world.current?.waiting.get(station.id) ?? 0;
    setWaitingCount(Math.floor(waiting));
  });

  return (
    <Html position={[station.center.x, 1.5, station.center.z]} center style={{ pointerEvents: 'none' }}>
      <div style={{ textAlign: 'center', whiteSpace: 'nowrap', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        
        {/* 順番バッジ (複数ある場合は横に並べる) */}
        {orderIndices.length > 0 && (
          <div style={{ display: 'flex', gap: '4px', marginBottom: '2px' }}>
            {orderIndices.map(idx => (
              <div key={idx} style={{ 
                background: '#ff0055', color: 'white', borderRadius: '50%', 
                width: '20px', height: '20px', lineHeight: '20px', fontSize: '12px',
                fontWeight: 'bold', boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
              }}>
                {idx + 1}
              </div>
            ))}
          </div>
        )}

        {/* 駅名 + ホームドア印 + 待ち人数 */}
        <div style={{
          background: 'rgba(0,0,0,0.6)', color: 'white', padding: '2px 6px',
          borderRadius: '4px', fontSize: '10px', backdropFilter: 'blur(2px)'
        }}>
          {station.name}
          {station.platformDoors === 'standard' && ' ▣'}
          {station.platformDoors === 'fullscreen' && ' ◼'}
          {' '}({waitingCount})
        </div>
      </div>
    </Html>
  );
};