import { describe, expect, it } from 'vitest';
import {
  compositeNoiseNumerator,
  heightFromNumerator,
  isWaterNumerator,
  splitNumeratorHiLo,
  heightFromNumeratorFor,
  heightThresholdsFor,
  HEIGHT_NUMERATOR_THRESHOLDS,
  WATER_NUMERATOR_THRESHOLD,
  ADJACENT_NUMERATOR_BOUND,
  TERRAIN_PROFILES,
} from './canonicalNoise';
import vectors from './__fixtures__/canonicalNoiseVectors.json';

interface Vector {
  seed: number;
  x: number;
  z: number;
  noiseNumHi: number;
  noiseNumLo: number;
  height: number;
  water: boolean;
}

describe('canonicalNoise: canonical integer fixed-point vectors (progress/canonical-terrain-noise-integer.md)', () => {
  const data = vectors as Vector[];

  it('has the full 1000-vector compatibility corpus', () => {
    expect(data.length).toBe(1000);
  });

  it('matches all 1000 canonical vectors byte-for-byte (numerator hi/lo, height, water)', () => {
    for (const v of data) {
      const n = compositeNoiseNumerator(v.seed, v.x, v.z);
      const { hi, lo } = splitNumeratorHiLo(n);
      expect({ hi, lo }, `seed=${v.seed} x=${v.x} z=${v.z}`).toEqual({ hi: v.noiseNumHi, lo: v.noiseNumLo });
      expect(heightFromNumerator(n), `seed=${v.seed} x=${v.x} z=${v.z} height`).toBe(v.height);
      expect(isWaterNumerator(n), `seed=${v.seed} x=${v.x} z=${v.z} water`).toBe(v.water);
    }
  });
});

describe('canonicalNoise: 地形プロファイル別のしきい値テーブル', () => {
  it('全プロファイルが10段のしきい値を単調増加で持つ', () => {
    for (const profile of TERRAIN_PROFILES) {
      const table = heightThresholdsFor(profile);
      expect(table.length, profile).toBe(10);
      for (let i = 1; i < table.length; i++) {
        expect(table[i], `${profile}[${i}]`).toBeGreaterThan(table[i - 1]);
      }
    }
  });

  it('全プロファイルのしきい値間隔が1-Lipschitz構成保証の上界以上である', () => {
    for (const profile of TERRAIN_PROFILES) {
      const table = heightThresholdsFor(profile);
      for (let i = 1; i < table.length; i++) {
        expect(table[i] - table[i - 1], `${profile}[${i}]`).toBeGreaterThanOrEqual(ADJACENT_NUMERATOR_BOUND);
      }
    }
  });

  it('全プロファイルで標高1のしきい値が水域しきい値より上にある(水セルは必ず標高0)', () => {
    for (const profile of TERRAIN_PROFILES) {
      expect(heightThresholdsFor(profile)[0], profile).toBeGreaterThan(WATER_NUMERATOR_THRESHOLD);
    }
  });

  it('normalは歴史的な既定テーブルと完全一致し、heightFromNumeratorの既定でもある', () => {
    expect(heightThresholdsFor('normal')).toEqual([
      35433480192, 41290253778, 47147027363, 53003800949, 58860574534,
      64717348120, 70574121705, 76430895291, 82287668876, 88144442462,
    ]);
    expect(heightThresholdsFor('normal')).toEqual(HEIGHT_NUMERATOR_THRESHOLDS);
    for (const n of [0, 1e9, 35433480192, 40e9, 60e9, 64424509439]) {
      expect(heightFromNumerator(n), `n=${n}`).toBe(heightFromNumeratorFor(n, 'normal'));
    }
  });

  it('同じNに対し 平坦 <= 標準 <= 山がち の順で標高が高くなる', () => {
    for (let i = 0; i < 2000; i++) {
      const n = compositeNoiseNumerator(i * 3, i * 7 - 500, i * 11 + 300);
      const flat = heightFromNumeratorFor(n, 'flat');
      const normal = heightFromNumeratorFor(n, 'normal');
      const mountain = heightFromNumeratorFor(n, 'mountain');
      expect(flat, `n=${n}`).toBeLessThanOrEqual(normal);
      expect(normal, `n=${n}`).toBeLessThanOrEqual(mountain);
    }
  });
});
