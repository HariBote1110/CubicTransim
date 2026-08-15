import { describe, expect, it } from 'vitest';
import {
  MESH_INSTANCE_FLAG_UNDERGROUND,
  MESH_INSTANCE_STRIDE,
  MESH_INSTANCE_TINT_WORD,
  packTintAndFlags,
} from './webgpuLayer';

describe('インスタンスのレイアウト(wasm 側 meshes.rs と同じ規約)', () => {
  it('stride は 6 ワード = 24 バイト', () => {
    expect(MESH_INSTANCE_STRIDE).toBe(6);
    expect(MESH_INSTANCE_TINT_WORD).toBe(5);
  });

  it('tint は unorm8x4 の R,G,B へ、flags は A バイトへ詰める', () => {
    const red = packTintAndFlags(1, 0, 0, 0);
    expect(red & 0xff).toBe(255);
    expect((red >>> 8) & 0xff).toBe(0);
    expect((red >>> 24) & 0xff).toBe(0);

    const blueUnderground = packTintAndFlags(0, 0, 1, MESH_INSTANCE_FLAG_UNDERGROUND);
    expect((blueUnderground >>> 16) & 0xff).toBe(255);
    expect((blueUnderground >>> 24) & 0xff).toBe(MESH_INSTANCE_FLAG_UNDERGROUND);
  });

  it('範囲外の tint はクランプする', () => {
    expect(packTintAndFlags(2, -1, 0.5, 0) & 0xff).toBe(255);
    expect((packTintAndFlags(2, -1, 0.5, 0) >>> 8) & 0xff).toBe(0);
    expect((packTintAndFlags(2, -1, 0.5, 0) >>> 16) & 0xff).toBe(128);
  });

  it('符号なし32bitとして扱える(A バイトが立っても負にならない)', () => {
    const packed = packTintAndFlags(1, 1, 1, MESH_INSTANCE_FLAG_UNDERGROUND);
    expect(packed).toBeGreaterThan(0);
    expect(packed).toBe(0x01ffffff);
  });
});
