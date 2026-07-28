import React, { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { CellData, TrainType, TrainData } from '../types';
import type { TrainRuntime } from '../sim/simulation';
import { carPositions } from '../sim/consist';
import { TrainCar, type CarVariant } from './TrainCar';
import { PALETTE } from '../render/palette';

interface DynamicTrainProps {
  data: TrainData;
  railMap: Map<string, CellData>;
  runtimes: Map<string, TrainRuntime>;
  type: TrainType;
  isSelected: boolean;
  /** 所属する運用グループのラインカラー。未所属なら車種の既定色を使う。 */
  lineColour?: string;
  onClick: (e: any) => void;
  /** この列車をドラッグで持ち上げている最中かどうか。 */
  isDragging?: boolean;
  /** ドラッグ中に追従させるカーソル位置のセル。 */
  dragCell?: { x: number; z: number } | null;
}

// ドラッグ中に列車を持ち上げる高さ(m相当)。地平の描画基準0.5からの上乗せ分。
const DRAG_LIFT_Y = 1.1;

// 車両の高さ基準。sim層のrenderPos.yは通常0.5(高架では0.5+OVERPASS_HEIGHT)で、
// TrainCarはこのyを車体中心付近として組んである(台車が概ねレール上面に接する)。
// 先頭車はrenderPos.yを、2両目以降はcarPositionsが返すy(編成一律の近似値)を使う。
// JSXの初期position(useFrameが一度も走る前)は地平の既定値0.5にしておく。
const INITIAL_CAR_Y = 0.5;
// 台車の車輪面から車両groupの原点までの高さ。坂で車体を傾けるとき、単に原点を
// 線路中心の真上に置くと車輪が線路から浮くため、車体のローカル上方向へ補正する。
const RAIL_SUPPORT_OFFSET = 0.37;

const carGroupPosition = (pos: { x: number; y: number; z: number }, heading: { x: number; y: number; z: number }) => {
  // world上方向を車両の進行方向に直交する平面へ射影したものが、車体のローカル+Yになる。
  const upY = Math.sqrt(Math.max(0, 1 - heading.y * heading.y));
  return {
    x: pos.x - heading.x * heading.y * RAIL_SUPPORT_OFFSET,
    y: pos.y + (upY - 1) * RAIL_SUPPORT_OFFSET,
    z: pos.z - heading.z * heading.y * RAIL_SUPPORT_OFFSET,
  };
};

export const DynamicTrain: React.FC<DynamicTrainProps> = ({
  data, railMap, runtimes, type, isSelected, lineColour: groupColour, onClick,
  isDragging, dragCell,
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

    // ドラッグ中(プラレールを掴んで移動中)は、通常の走行位置計算を無視してカーソル位置に
    // 持ち上げて追従させる。編成全体をまとめて一塊として動かす(凝った連結表現はしない)。
    if (isDragging && dragCell) {
      groupRef.current.position.set(dragCell.x, DRAG_LIFT_Y, dragCell.z);
      for (let i = 1; i < carRefs.current.length; i++) {
        const carGroup = carRefs.current[i];
        if (!carGroup) continue;
        carGroup.position.set(dragCell.x, DRAG_LIFT_Y, dragCell.z - 0.92 * i);
      }
      return;
    }

    // 全車両を carPositions の結果で配置する。先頭車も renderTarget への lookAt ではなく
    // 前後台車から求めた heading を使う:
    //   - 到着tickでは renderPos と renderTarget が同じセル中心になり、lookAt が縮退して
    //     1フレームだけワールド+Z方向を向いてしまう(向きがガクッと飛ぶ原因)
    //   - セグメントの向きをそのまま使うとセル境界で階段状に飛ぶ
    const positions = carPositions(runtime, data.cars, 1.0, railMap);

    const head = positions[0];
    if (head) {
      const headGroupPos = carGroupPosition(head, head.heading);
      groupRef.current.position.set(headGroupPos.x, headGroupPos.y, headGroupPos.z);
      groupRef.current.lookAt(
        head.x + head.heading.x,
        head.y + head.heading.y,
        head.z + head.heading.z
      );
    }

    // 2両目以降: 先頭からの弧長ベースで連続的に後方配置する(carPositions)。
    // trailのようなセル単位の配置ではなくポリライン補間なので、セル境界を跨いでもカクつかない。
    for (let i = 1; i < carRefs.current.length; i++) {
      const carGroup = carRefs.current[i];
      if (!carGroup) continue;
      const pos = positions[i];
      if (!pos) continue;
      const groupPos = carGroupPosition(pos, pos.heading);
      carGroup.position.set(groupPos.x, groupPos.y, groupPos.z);
      carGroup.lookAt(pos.x + pos.heading.x, pos.y + pos.heading.y, pos.z + pos.heading.z);
    }

    if (isSelected) {
      if (speedTextRef.current) speedTextRef.current.textContent = `${Math.round(runtime.speedKmh)} km/h`;
      if (statusTextRef.current) statusTextRef.current.textContent = runtime.debugStatus;
      setDisplayRoute(runtime.route);
    }
  });

  if (data.status === 'stored') return null;

  const lineColour = isSelected
    ? PALETTE.carLineSelected
    : (groupColour ?? (type === 'express' ? '#e2571f' : PALETTE.carLine));
  const trailingCars = Math.max(0, data.cars - 1);
  // 1両編成なら先頭車のみ。それ以外は最後尾だけ 'rear'(尾灯つき)にする。
  const variantOf = (index: number): CarVariant =>
    index === 0 ? 'front' : (index === data.cars - 1 ? 'rear' : 'middle');

  return (
    <group>
      {/* 2両目以降(後続車両) */}
      {Array.from({ length: trailingCars }).map((_, idx) => (
        <group key={`car-${idx}`} ref={el => { carRefs.current[idx + 1] = el; }}>
          <TrainCar variant={variantOf(idx + 1)} lineColour={lineColour} />
        </group>
      ))}

      <group
        ref={(el) => { groupRef.current = el; carRefs.current[0] = el; }}
        position={[data.x, INITIAL_CAR_Y, data.z]}
        scale={isDragging ? 0.94 : 1}
        onClick={(e) => { e.stopPropagation(); onClick(e); }}
      >
        <TrainCar variant="front" lineColour={lineColour} />

        {isSelected && (
          <mesh position={[0, 0.85, 0]} rotation={[Math.PI, 0, 0]} raycast={() => null}>
            <coneGeometry args={[0.16, 0.28, 4]} />
            <meshBasicMaterial color={PALETTE.carLineSelected} />
          </mesh>
        )}

        {isSelected && (
          <Html position={[0, 1.6, 0]} center style={{ pointerEvents: 'none', width: '200px', textAlign: 'center' }}>
            <div style={{
              background: 'rgba(17,22,28,0.86)', color: '#f4f7fa', padding: '5px 9px',
              borderRadius: '7px', fontSize: '11px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              border: '1px solid rgba(255,255,255,0.18)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            }}>
              <div style={{ fontWeight: 700 }}>{data.id}</div>
              <div ref={speedTextRef} style={{ color: '#8fe3a5', fontWeight: 'bold' }} />
              <div ref={statusTextRef} style={{ color: '#b9c3cc' }} />
            </div>
          </Html>
        )}
      </group>

      {isSelected && displayRoute.map((pos, i) => (
        <mesh key={`route-${i}`} position={[pos.x, 0.2, pos.z]} raycast={() => null}>
          <sphereGeometry args={[0.07]} />
          <meshBasicMaterial color="#ffd23f" transparent opacity={0.5} />
        </mesh>
      ))}
    </group>
  );
};
