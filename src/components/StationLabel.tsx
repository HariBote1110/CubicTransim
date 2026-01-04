import React from 'react';
import { Html } from '@react-three/drei';
import type { StationData } from '../types';

interface Props {
  station: StationData;
  orderIndices: number[]; // 変更: 複数の番号を受け取る配列
}

export const StationLabel: React.FC<Props> = ({ station, orderIndices }) => {
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

        {/* 駅名 */}
        <div style={{ 
          background: 'rgba(0,0,0,0.6)', color: 'white', padding: '2px 6px', 
          borderRadius: '4px', fontSize: '10px', backdropFilter: 'blur(2px)'
        }}>
          {station.name}
        </div>
      </div>
    </Html>
  );
};