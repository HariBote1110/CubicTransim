import { describe, expect, it } from 'vitest';
import { BufferGeometry, BufferAttribute, Float32BufferAttribute } from './geom';

describe('BufferGeometry: three.js互換の最小サブセット', () => {
  it('positionsで初期化し、getAttributeで読み出せる', () => {
    const g = new BufferGeometry(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    expect(g.getAttribute('position')?.count).toBe(3);
    expect(g.getAttribute('normal')).toBeUndefined();
  });

  it('translateで全頂点が平行移動する', () => {
    const g = new BufferGeometry(new Float32Array([0, 0, 0, 1, 0, 0]));
    g.translate(2, 3, 4);
    expect(Array.from(g.positions)).toEqual([2, 3, 4, 3, 3, 4]);
  });

  it('rotateYはY軸まわり右手系の回転(three.jsのMatrix4.makeRotationYと同じ式)', () => {
    const g = new BufferGeometry(new Float32Array([1, 0, 0]));
    g.rotateY(Math.PI / 2);
    expect(g.positions[0]).toBeCloseTo(0, 6);
    expect(g.positions[2]).toBeCloseTo(-1, 6);
  });

  it('rotateXはX軸まわりの回転', () => {
    const g = new BufferGeometry(new Float32Array([0, 1, 0]));
    g.rotateX(Math.PI / 2);
    expect(g.positions[1]).toBeCloseTo(0, 6);
    expect(g.positions[2]).toBeCloseTo(1, 6);
  });

  it('rotateZはZ軸まわりの回転', () => {
    const g = new BufferGeometry(new Float32Array([1, 0, 0]));
    g.rotateZ(Math.PI / 2);
    expect(g.positions[0]).toBeCloseTo(0, 6);
    expect(g.positions[1]).toBeCloseTo(1, 6);
  });

  it('indexなしのtoNonIndexedは自分自身を返す(コピーしない)', () => {
    const g = new BufferGeometry(new Float32Array([0, 0, 0]));
    expect(g.toNonIndexed()).toBe(g);
  });

  it('indexありのtoNonIndexedは共有頂点を三角形ごとに複製する', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    const indices = new Uint32Array([0, 1, 2, 1, 3, 2]);
    const g = new BufferGeometry(positions, indices);
    expect(g.index).toBe(indices);
    const soup = g.toNonIndexed();
    expect(soup.index).toBeNull();
    expect(soup.vertexCount).toBe(6);
    expect(Array.from(soup.positions.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(soup.positions.slice(9, 12))).toEqual([1, 0, 0]);
  });

  it('computeBoundingBoxがmin/maxを求める', () => {
    const g = new BufferGeometry(new Float32Array([-1, 2, 0, 3, -4, 5]));
    g.computeBoundingBox();
    expect(g.boundingBox).toEqual({ min: { x: -1, y: -4, z: 0 }, max: { x: 3, y: 2, z: 5 } });
  });

  it('disposeは呼んでも例外にならない(no-op)', () => {
    const g = new BufferGeometry();
    expect(() => g.dispose()).not.toThrow();
  });
});

describe('BufferAttribute / Float32BufferAttribute', () => {
  it('itemSizeからcountを求める', () => {
    const a = new BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 1]), 3);
    expect(a.count).toBe(2);
    const b = new Float32BufferAttribute([0, 0, 1, 0], 2);
    expect(b.count).toBe(2);
    expect(b.array).toBeInstanceOf(Float32Array);
  });
});
