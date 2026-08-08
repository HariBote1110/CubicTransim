// R4e: three.js の BufferGeometry を代替する最小限のCPU側ジオメトリ型。
//
// bakedMesh.ts のベイク処理は各三角形の3頂点位置から法線を都度計算する(flat shading)ため、
// normal/uv 属性は最終的な見た目に一切寄与しない(mergeGeometry.ts が以前やっていた
// 「属性の和集合をゼロ埋めで揃える」処理も、position 以外を保持しなくなったことで不要になった)。
// このキットは position(と、互換性のためだけの index)のみを保持する。

export interface AttributeLike {
  array: Float32Array;
  itemSize: number;
  count: number;
}

export interface BoundingBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/** three.js BufferGeometry 互換の最小サブセット。position属性のみを実体として持つ。 */
export class BufferGeometry {
  positions: Float32Array;
  private indices: Uint32Array | null;
  boundingBox: BoundingBox | null = null;

  constructor(positions: Float32Array = new Float32Array(0), indices: Uint32Array | null = null) {
    this.positions = positions;
    this.indices = indices;
  }

  /** three.js の `geometry.index`(非nullならindexed)と同じ真偽の意味で使う。 */
  get index(): Uint32Array | null {
    return this.indices;
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  getAttribute(name: string): AttributeLike | undefined {
    if (name !== 'position') return undefined;
    return { array: this.positions, itemSize: 3, count: this.vertexCount };
  }

  setAttribute(name: string, attribute: AttributeLike): this {
    if (name === 'position') this.positions = attribute.array;
    return this;
  }

  /** indexed の場合、共有頂点を三角形ごとに複製した非indexedジオメトリを新規に返す。 */
  toNonIndexed(): BufferGeometry {
    if (!this.indices) return this;
    const idx = this.indices;
    const out = new Float32Array(idx.length * 3);
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i] * 3;
      out[i * 3] = this.positions[v];
      out[i * 3 + 1] = this.positions[v + 1];
      out[i * 3 + 2] = this.positions[v + 2];
    }
    return new BufferGeometry(out, null);
  }

  translate(x: number, y: number, z: number): this {
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) {
      p[i] += x;
      p[i + 1] += y;
      p[i + 2] += z;
    }
    return this;
  }

  rotateX(angle: number): this {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) {
      const y = p[i + 1];
      const z = p[i + 2];
      p[i + 1] = y * c - z * s;
      p[i + 2] = y * s + z * c;
    }
    return this;
  }

  rotateY(angle: number): this {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i];
      const z = p[i + 2];
      p[i] = x * c + z * s;
      p[i + 2] = -x * s + z * c;
    }
    return this;
  }

  rotateZ(angle: number): this {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i];
      const y = p[i + 1];
      p[i] = x * c - y * s;
      p[i + 1] = x * s + y * c;
    }
    return this;
  }

  computeBoundingBox(): void {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    this.boundingBox = { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
  }

  /** three.js との互換のためだけに残す(実体はGCに任せるので何もしない)。 */
  dispose(): void {
    // no-op
  }
}

export class BufferAttribute implements AttributeLike {
  array: Float32Array;
  itemSize: number;

  constructor(array: Float32Array | number[], itemSize: number) {
    this.array = array instanceof Float32Array ? array : new Float32Array(array);
    this.itemSize = itemSize;
  }

  get count(): number {
    return this.array.length / this.itemSize;
  }
}

/** three.js では BufferAttribute のサブクラスだが、このキットでは同一実装で足りる。 */
export class Float32BufferAttribute extends BufferAttribute {}
