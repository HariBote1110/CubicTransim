import { describe, expect, it } from 'vitest';
import { carGroupPosition, headingToYawPitch, RAIL_SUPPORT_OFFSET } from './trainInstanceMath';

describe('carGroupPosition', () => {
  it('leaves the position unchanged on flat, level heading', () => {
    const pos = { x: 3, y: 0.5, z: -2 };
    const heading = { x: 0, y: 0, z: 1 };
    expect(carGroupPosition(pos, heading)).toEqual({ x: 3, y: 0.5, z: -2 });
  });

  it('lowers the group origin when the train climbs (heading.y != 0)', () => {
    const heading = { x: 0, y: 0.6, z: 0.8 };
    const pos = { x: 0, y: 1, z: 0 };
    const result = carGroupPosition(pos, heading);
    const upY = Math.sqrt(1 - heading.y * heading.y);
    expect(result.y).toBeCloseTo(pos.y + (upY - 1) * RAIL_SUPPORT_OFFSET, 10);
    // 水平移動もheading.x/z*heading.yに比例して起きる
    expect(result.z).toBeCloseTo(pos.z - heading.z * heading.y * RAIL_SUPPORT_OFFSET, 10);
  });
});

describe('headingToYawPitch', () => {
  it('is zero/zero for +Z (forward, level)', () => {
    const { yaw, pitch } = headingToYawPitch({ x: 0, y: 0, z: 1 });
    expect(yaw).toBeCloseTo(0, 10);
    expect(pitch).toBeCloseTo(0, 10);
  });

  it('yaws by +90deg for +X heading', () => {
    const { yaw, pitch } = headingToYawPitch({ x: 1, y: 0, z: 0 });
    expect(yaw).toBeCloseTo(Math.PI / 2, 10);
    expect(pitch).toBeCloseTo(0, 10);
  });

  it('yaws by 180deg for -Z heading (tail flip case)', () => {
    const { yaw, pitch } = headingToYawPitch({ x: 0, y: 0, z: -1 });
    expect(Math.abs(yaw)).toBeCloseTo(Math.PI, 10);
    expect(pitch).toBeCloseTo(0, 10);
  });

  it('pitches nose-up (negative pitch) when climbing (+Y)', () => {
    const { yaw, pitch } = headingToYawPitch({ x: 0, y: 1, z: 0 });
    expect(yaw).toBeCloseTo(0, 10);
    expect(pitch).toBeCloseTo(-Math.PI / 2, 10);
  });

  it('round-trips through the shader rotation order for an arbitrary heading', () => {
    const raw = { x: 0.4, y: -0.3, z: 0.866 };
    const len = Math.hypot(raw.x, raw.y, raw.z);
    const heading = { x: raw.x / len, y: raw.y / len, z: raw.z / len };
    const { yaw, pitch } = headingToYawPitch(heading);

    // mesh_instanced.wgsl の頂点変換をそのままJSで再現し、ローカル+Zがheadingへ一致するか検証する。
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const pitched = { y: 0 * cp - 1 * sp, z: 0 * sp + 1 * cp }; // ローカル(0,0,1)にピッチを適用
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const rotated = {
      x: 0 * cy + pitched.z * sy,
      y: pitched.y,
      z: -0 * sy + pitched.z * cy,
    };
    expect(rotated.x).toBeCloseTo(heading.x, 10);
    expect(rotated.y).toBeCloseTo(heading.y, 10);
    expect(rotated.z).toBeCloseTo(heading.z, 10);
  });
});
