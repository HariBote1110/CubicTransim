import React from 'react';
import { MATERIALS, PALETTE, bodyMaterial } from '../render/palette';

export type CarVariant = 'front' | 'middle' | 'rear';

interface Props {
  variant: CarVariant;
  /** 帯(ラインカラー)。選択中の列車は色を変えて識別する。 */
  lineColour: string;
}

// --- 寸法(1セル=1.0、車間spacing=1.0なので車体長0.86で0.14の隙間ができる) ---
const LEN = 0.86;
const WIDTH = 0.44;
const BODY_H = 0.30;
const BODY_Y = 0.06;      // 車体中心(groupのy=0が世界のy=0.5)
const ROOF_Y = BODY_Y + BODY_H / 2 + 0.025;
const SKIRT_Y = BODY_Y - BODY_H / 2 - 0.045;
const BOGIE_Y = -0.29;
const WINDOW_Y = BODY_Y + 0.045;
const NOSE = LEN / 2;

/**
 * 1両ぶんの車両。
 *
 * 「箱1個」だったものを、床下機器・台車・車体・窓帯・ラインカラー帯・屋根・
 * 先頭車の前面(貫通扉・前照灯・尾灯)に分解したローポリモデルにしている。
 * variant で先頭車/中間車/最後尾を作り分け、編成の向きが一目で分かるようにする。
 *
 * ローカル +Z が進行方向(DynamicTrainのlookAtがそう向ける)。
 */
export const TrainCar: React.FC<Props> = ({ variant, lineColour }) => {
  const body = bodyMaterial(PALETTE.carBody);
  const line = bodyMaterial(lineColour);
  const isCab = variant !== 'middle';

  return (
    <group>
      {/* 台車(前後2つ) */}
      {[-0.26, 0.26].map((z, i) => (
        <mesh key={i} position={[0, BOGIE_Y, z]} material={MATERIALS.carBogie}>
          <boxGeometry args={[WIDTH - 0.06, 0.16, 0.24]} />
        </mesh>
      ))}

      {/* 床下機器 */}
      <mesh position={[0, SKIRT_Y, 0]} material={MATERIALS.carSkirt}>
        <boxGeometry args={[WIDTH - 0.03, 0.09, LEN - 0.1]} />
      </mesh>

      {/* 車体 */}
      <mesh position={[0, BODY_Y, 0]} castShadow material={body}>
        <boxGeometry args={[WIDTH, BODY_H, LEN]} />
      </mesh>

      {/* 側面窓帯(左右) */}
      {[-1, 1].map(side => (
        <mesh key={side} position={[side * (WIDTH / 2 + 0.002), WINDOW_Y, 0]} material={MATERIALS.carWindow}>
          <boxGeometry args={[0.012, 0.105, LEN - 0.2]} />
        </mesh>
      ))}

      {/* ラインカラーの帯(腰板部) */}
      {[-1, 1].map(side => (
        <mesh key={side} position={[side * (WIDTH / 2 + 0.002), BODY_Y - 0.085, 0]} material={line}>
          <boxGeometry args={[0.014, 0.055, LEN - 0.04]} />
        </mesh>
      ))}

      {/* 屋根(車体より一回り小さくして肩の丸みを出す) */}
      <mesh position={[0, ROOF_Y, 0]} castShadow material={MATERIALS.carRoof}>
        <boxGeometry args={[WIDTH - 0.07, 0.05, LEN - 0.03]} />
      </mesh>
      {/* 屋根上のクーラー */}
      {[-0.22, 0.22].map((z, i) => (
        <mesh key={i} position={[0, ROOF_Y + 0.038, z]} material={MATERIALS.carRoof}>
          <boxGeometry args={[WIDTH - 0.19, 0.03, 0.16]} />
        </mesh>
      ))}

      {/* 先頭車/最後尾の前面 */}
      {isCab && (() => {
        const dir = variant === 'front' ? 1 : -1;
        const faceZ = dir * (NOSE + 0.004);
        return (
          <group>
            {/* 前面窓(大きめのガラス) */}
            <mesh position={[0, WINDOW_Y + 0.015, faceZ]} material={MATERIALS.carWindow}>
              <boxGeometry args={[WIDTH - 0.09, 0.11, 0.014]} />
            </mesh>
            {/* 前面のラインカラー帯 */}
            <mesh position={[0, BODY_Y - 0.085, faceZ]} material={line}>
              <boxGeometry args={[WIDTH - 0.02, 0.05, 0.014]} />
            </mesh>
            {/* 前照灯 / 尾灯 */}
            {[-1, 1].map(sx => (
              <mesh
                key={sx}
                position={[sx * (WIDTH / 2 - 0.075), BODY_Y - 0.025, faceZ + dir * 0.006]}
                material={variant === 'front' ? MATERIALS.headlight : MATERIALS.taillight}
              >
                <boxGeometry args={[0.05, 0.032, 0.012]} />
              </mesh>
            ))}
            {/* 連結器(反対側の妻面には出さない) */}
            <mesh position={[0, SKIRT_Y - 0.02, dir * (NOSE + 0.03)]} material={MATERIALS.carBogie}>
              <boxGeometry args={[0.07, 0.05, 0.06]} />
            </mesh>
          </group>
        );
      })()}
    </group>
  );
};
