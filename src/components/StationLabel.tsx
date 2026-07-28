import React, { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { StationData } from '../types';
import type { SimWorld } from '../sim/simulation';
import { T } from '../ui/theme';

interface Props {
  station: StationData;
  orderIndices: number[]; // 選択中の列車の運行表における停車順(複数可)
  world: React.RefObject<SimWorld>;
  /** ラベルの高さ(既定1.35)。高架ホームを含む駅は、高架の上屋にめり込まないよう呼び出し側で高くする。 */
  labelY?: number;
}

// 待ち人数の更新頻度(秒)。sim層のwaitingは毎tick更新されるが、
// 表示はDynamicTrainの速度表示と同様に低頻度のsetStateで十分。
const WAITING_DISPLAY_INTERVAL = 0.5;

// ホームドアの設置状況を示すバッジ。
const DOOR_BADGE = {
  none: null,
  standard: { label: '半', title: '標準ホームドア' },
  fullscreen: { label: '全', title: 'フルスクリーンホームドア' },
} as const;

export const StationLabel: React.FC<Props> = ({ station, orderIndices, world, labelY = 1.35 }) => {
  const [waitingCount, setWaitingCount] = useState(0);
  const elapsedRef = useRef(0);

  useFrame((_state, delta) => {
    elapsedRef.current += delta;
    if (elapsedRef.current < WAITING_DISPLAY_INTERVAL) return;
    elapsedRef.current = 0;
    setWaitingCount(Math.floor(world.current?.waiting.get(station.id) ?? 0));
  });

  const door = DOOR_BADGE[station.platformDoors];

  return (
    <Html position={[station.center.x, labelY, station.center.z]} center style={{ pointerEvents: 'none' }}>
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        whiteSpace: 'nowrap', fontFamily: T.font,
      }}>
        {/* 停車順のバッジ(選択中の列車の運行表に含まれる駅のみ) */}
        {orderIndices.length > 0 && (
          <div style={{ display: 'flex', gap: 3, marginBottom: 3 }}>
            {orderIndices.map(idx => (
              <div key={idx} style={{
                background: T.accent, color: T.accentInk, borderRadius: '50%',
                width: 18, height: 18, fontSize: 11, fontWeight: 700,
                display: 'grid', placeItems: 'center', boxShadow: T.shadowSm,
              }}>
                {idx + 1}
              </div>
            ))}
          </div>
        )}

        {/* 駅名 + ホームドア + 待ち人数 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: T.ink, color: T.text,
          border: `1px solid ${T.line}`, borderRadius: T.radiusPill,
          padding: '3px 9px', fontSize: 11, fontWeight: 600,
          boxShadow: T.shadowSm, backdropFilter: T.blur,
        }}>
          {station.name}
          {door && (
            <span
              title={door.title}
              style={{
                fontSize: 9, fontWeight: 700, color: T.accent,
                border: `1px solid ${T.accent}`, borderRadius: 3, padding: '0 3px', lineHeight: '12px',
              }}
            >
              {door.label}
            </span>
          )}
          <span style={{ color: T.textMuted, fontVariantNumeric: 'tabular-nums' }}>
            {waitingCount}人
          </span>
        </div>
      </div>
    </Html>
  );
};
