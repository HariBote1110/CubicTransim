import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  SUN_DIRECTION, AMBIENT_TERM, HEMISPHERE_TERM, SUN_TERM,
  lambertFactor, packRgba, parseColourHex, bakeFlatShaded, bakeGeometries,
} from './bakedMesh';

describe('lambertFactor', () => {
  it('太陽の真正面を向く面が最も明るい(上限1.0)', () => {
    const facing = lambertFactor(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]);
    const expected = Math.min(
      1,
      AMBIENT_TERM + HEMISPHERE_TERM * (0.5 + 0.5 * SUN_DIRECTION[1]) + SUN_TERM,
    );
    expect(facing).toBeCloseTo(expected, 6);
  });

  it('太陽に背を向ける面でも環境光ぶんは残る(真っ黒にしない)', () => {
    const away = lambertFactor(-SUN_DIRECTION[0], -SUN_DIRECTION[1], -SUN_DIRECTION[2]);
    expect(away).toBeGreaterThan(0.1);
    expect(away).toBeLessThan(lambertFactor(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]));
  });

  it('上向きの面は下向きの面より明るい(半球光)', () => {
    expect(lambertFactor(0, 1, 0)).toBeGreaterThan(lambertFactor(0, -1, 0));
    expect(lambertFactor(0, -1, 0)).toBeCloseTo(AMBIENT_TERM, 6);
  });

  it('法線が正規化されていなくても同じ結果になる', () => {
    expect(lambertFactor(0, 5, 0)).toBeCloseTo(lambertFactor(0, 1, 0), 6);
  });
});

describe('packRgba / parseColourHex', () => {
  it('RGBA8をリトルエンディアンのu32(0xAABBGGRR)へ詰める', () => {
    expect(packRgba(255, 0, 0, 255)).toBe(0xff0000ff);
    expect(packRgba(0, 255, 0, 0)).toBe(0x0000ff00);
  });

  it('0..255へ丸めてクランプする', () => {
    expect(packRgba(300, -5, 0.4, 255)).toBe(0xff0000ff);
  });

  it('16進の色文字列を0..1のRGBへ変換する', () => {
    expect(parseColourHex('#4f7c3a')).toEqual([0x4f / 255, 0x7c / 255, 0x3a / 255]);
    expect(parseColourHex('4f7c3a')).toEqual([0x4f / 255, 0x7c / 255, 0x3a / 255]);
  });
});

describe('bakeFlatShaded', () => {
  // xz平面に載る上向きの三角形(法線 = +Y)。
  const upward = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0]);

  it('面の法線から求めた係数を頂点色へ焼き込む', () => {
    const baked = bakeFlatShaded(upward, [1, 1, 1]);
    const expected = Math.round(255 * lambertFactor(0, 1, 0));
    expect(baked.positions).toEqual(upward);
    expect(baked.colours).toHaveLength(3);
    for (const c of baked.colours) {
      expect(c & 0xff).toBe(expected); // R
      expect((c >>> 8) & 0xff).toBe(expected); // G
      expect((c >>> 24) & 0xff).toBe(255); // A(既定は不透明)
    }
  });

  it('巻き順を反転した面(=下向き)は暗くなる', () => {
    const downward = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(bakeFlatShaded(downward, [1, 1, 1]).colours[0] & 0xff).toBe(Math.round(255 * AMBIENT_TERM));
  });

  it('multiplierで全体を減光できる(遠景フェード・地下ビュー用)', () => {
    const half = bakeFlatShaded(upward, [1, 1, 1], { multiplier: 0.5 }).colours[0] & 0xff;
    expect(half).toBe(Math.round(255 * lambertFactor(0, 1, 0) * 0.5));
  });

  it('alphaを指定するとA成分に載る(半透明クラス・インスタンスtint重み用)', () => {
    const baked = bakeFlatShaded(upward, [1, 1, 1], { alpha: 128 });
    expect((baked.colours[0] >>> 24) & 0xff).toBe(128);
  });

  it('三角形に満たない端数は無視する', () => {
    expect(bakeFlatShaded(new Float32Array([0, 0, 0, 1, 0, 0]), [1, 1, 1]).colours).toHaveLength(0);
  });
});

describe('bakeGeometries', () => {
  it('複数バケットを1つのメッシュチャンクへ連結し、AABBを返す', () => {
    const a = new THREE.BoxGeometry(1, 1, 1);
    const b = new THREE.BoxGeometry(1, 1, 1).translate(4, 2, 0);
    const baked = bakeGeometries([
      { geometry: a, colour: '#ff0000' },
      { geometry: b, colour: '#00ff00' },
    ]);
    expect(baked).not.toBeNull();
    // BoxGeometryは12三角形=36頂点(非インデックス化後)。
    expect(baked!.positions.length / 3).toBe(72);
    expect(baked!.indices.length).toBe(72);
    expect(baked!.indices[71]).toBe(71);
    expect(baked!.aabb).toEqual(new Float32Array([-0.5, -0.5, -0.5, 4.5, 2.5, 0.5]));
    a.dispose();
    b.dispose();
  });

  it('空の入力にはnullを返す(空チャンクをアップロードしない)', () => {
    expect(bakeGeometries([])).toBeNull();
  });
});
