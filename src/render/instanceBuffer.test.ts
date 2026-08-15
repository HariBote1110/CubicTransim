import { describe, expect, it } from 'vitest';
import { InstanceBuffer } from './instanceBuffer';
import { MESH_INSTANCE_FLAG_UNDERGROUND, MESH_INSTANCE_STRIDE } from './webgpuLayer';

/** view() の1件分を読み解く(u32 ワードは同じ ArrayBuffer の別ビューから読む)。 */
function readInstance(buf: InstanceBuffer, index: number) {
  const view = buf.view();
  const words = new Uint32Array(view.buffer, view.byteOffset, view.length);
  const o = index * MESH_INSTANCE_STRIDE;
  const packed = words[o + 5];
  return {
    x: view[o], y: view[o + 1], z: view[o + 2], yaw: view[o + 3], pitch: view[o + 4],
    tint: [packed & 0xff, (packed >>> 8) & 0xff, (packed >>> 16) & 0xff],
    flags: (packed >>> 24) & 0xff,
  };
}

describe('InstanceBuffer', () => {
  it('1件を stride 24 バイトで書き、位置・回転・tint・flags を往復できる', () => {
    const buf = new InstanceBuffer();
    buf.push(1.5, 2.5, 3.5, 0.25, -0.5, 1, 0, 0.5, MESH_INSTANCE_FLAG_UNDERGROUND);

    expect(buf.view().length).toBe(MESH_INSTANCE_STRIDE);
    expect(buf.view().byteLength).toBe(24);

    const inst = readInstance(buf, 0);
    expect(inst.x).toBe(1.5);
    expect(inst.y).toBe(2.5);
    expect(inst.z).toBe(3.5);
    expect(inst.yaw).toBe(0.25);
    expect(inst.pitch).toBe(-0.5);
    expect(inst.tint).toEqual([255, 0, 128]);
    expect(inst.flags).toBe(MESH_INSTANCE_FLAG_UNDERGROUND);
  });

  it('reset() で件数だけ戻し、確保済み領域は使い回す', () => {
    const buf = new InstanceBuffer();
    const before = buf.data;
    buf.push(1, 0, 0, 0, 0, 1, 1, 1, 0);
    buf.reset();
    expect(buf.view().length).toBe(0);
    expect(buf.data).toBe(before);
  });

  /** 伸長時に u32 ビューを張り直し忘れると、古いバッファへ書いて tint が消える。 */
  it('容量を超えて詰めても全件が正しく読める(伸長後も u32 ビューが追従する)', () => {
    const buf = new InstanceBuffer();
    const count = 200;
    for (let i = 0; i < count; i++) {
      buf.push(i, 0, 0, 0, 0, 1, 0, 0, i % 2 === 0 ? 0 : MESH_INSTANCE_FLAG_UNDERGROUND);
    }
    expect(buf.view().length).toBe(count * MESH_INSTANCE_STRIDE);
    for (const i of [0, 1, 16, 17, 99, count - 1]) {
      const inst = readInstance(buf, i);
      expect(inst.x, `instance ${i} の x`).toBe(i);
      expect(inst.tint, `instance ${i} の tint`).toEqual([255, 0, 0]);
      expect(inst.flags, `instance ${i} の flags`).toBe(i % 2 === 0 ? 0 : MESH_INSTANCE_FLAG_UNDERGROUND);
    }
  });
});
