import { MESH_INSTANCE_STRIDE, MESH_INSTANCE_TINT_WORD, packTintAndFlags } from './webgpuLayer';

/**
 * 伸長可能なインスタンス配列バッファ。フレームごとの確保を避けるため、
 * 必要な時だけ倍化して使い回す。
 *
 * 1件は 24 バイト = [x, y, z, yaw, pitch, tint+flags] で、最後の1ワードだけ u32 として
 * 書く必要がある。そのため同じ ArrayBuffer を見る u32 ビューを併せ持ち、伸長時には
 * **両方を張り直す**(片方だけ差し替えると古い領域へ書き込んで色が消える)。
 */
export class InstanceBuffer {
  data = new Float32Array(MESH_INSTANCE_STRIDE * 16);
  private words = new Uint32Array(this.data.buffer);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  push(
    x: number, y: number, z: number, yaw: number, pitch: number,
    tintR: number, tintG: number, tintB: number, flags: number,
  ): void {
    const offset = this.count * MESH_INSTANCE_STRIDE;
    if (offset + MESH_INSTANCE_STRIDE > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
      this.words = new Uint32Array(grown.buffer);
    }
    this.data[offset] = x;
    this.data[offset + 1] = y;
    this.data[offset + 2] = z;
    this.data[offset + 3] = yaw;
    this.data[offset + 4] = pitch;
    this.words[offset + MESH_INSTANCE_TINT_WORD] = packTintAndFlags(tintR, tintG, tintB, flags);
    this.count += 1;
  }

  view(): Float32Array {
    return this.data.subarray(0, this.count * MESH_INSTANCE_STRIDE);
  }
}
