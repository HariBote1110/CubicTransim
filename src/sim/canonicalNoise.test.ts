import { describe, expect, it } from 'vitest';
import {
  compositeNoiseNumerator,
  heightFromNumerator,
  isWaterNumerator,
  splitNumeratorHiLo,
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
