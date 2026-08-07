import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createTerrainField } from '../../../src/sim/terrainField';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTO = path.resolve(HERE, '..');
const DUMP_BIN = path.join(PROTO, 'target', 'release', 'dump');
const TMP = path.join(PROTO, '.tmp', 'direct-terrain-field');

const SEED = 0x1234_5678;
const HALF_EXTENT = 8192;
const COUNT = 1_000_000;

/**
 * Direct bridge test: the production TypeScript terrainField implementation is loaded
 * by Vitest (not copied/reimplemented here), while the Rust reference emits the exact
 * same deterministic one-million coordinate sequence.  Compare all 1,000,000 returned
 * corner heights byte-for-byte.
 */
describe('production terrainField.ts ↔ Rust terrain core', () => {
  it('matches cornerHeightAt byte-for-byte for 1,000,000 deterministic points', () => {
    fs.mkdirSync(TMP, { recursive: true });
    const rustPath = path.join(TMP, 'rust-heights.bin');

    const rust = spawnSync(
      DUMP_BIN,
      [String(SEED), String(COUNT), String(HALF_EXTENT), rustPath],
      { encoding: 'utf8' },
    );
    expect(rust.error).toBeUndefined();
    expect(rust.status, `${rust.stderr}\n${rust.stdout}`).toBe(0);

    const expected = fs.readFileSync(rustPath);
    expect(expected.byteLength).toBe(COUNT);

    const field = createTerrainField(SEED, HALF_EXTENT);
    const actual = Buffer.allocUnsafe(COUNT);
    let state = 0x6d2b_79f5 >>> 0;
    const span = HALF_EXTENT * 2 + 1;
    for (let i = 0; i < COUNT; i++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const x = (state % span) - HALF_EXTENT;
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const z = (state % span) - HALF_EXTENT;
      actual[i] = field.cornerHeightAt(x, z);
    }

    expect(Buffer.compare(actual, expected)).toBe(0);
  });
});
