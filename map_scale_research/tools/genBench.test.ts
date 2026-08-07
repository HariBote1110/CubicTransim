// 研究用ベンチ: 標高生成パイプライン(generateHeights→normaliseHeights)のrangeスケーリング実測。
// 実行: npx vitest run map_scale_research/tools/genBench.test.ts
import { test } from 'vitest';
import { generateHeights, normaliseHeights } from '../../src/sim/terrain';
import { mulberry32 } from '../../src/sim/towns';

const RANGES = [45, 64, 91, 128, 181, 256];
const RUNS = 5;

test('heights pipeline scaling', () => {
  // ウォームアップ
  normaliseHeights(generateHeights(mulberry32(1), 45), 45);

  for (const range of RANGES) {
    const gen: number[] = [];
    const norm: number[] = [];
    let cells = 0;
    for (let run = 0; run < RUNS; run++) {
      const rng = mulberry32(42 + run);
      let t0 = performance.now();
      const raw = generateHeights(rng, range);
      let t1 = performance.now();
      const heights = normaliseHeights(raw, range);
      const t2 = performance.now();
      gen.push(t1 - t0);
      norm.push(t2 - t1);
      cells = (2 * range + 1) ** 2;
      void heights;
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(
      `range=${range} (${2 * range + 1}x${2 * range + 1}=${cells}cells) ` +
      `generateHeights median=${median(gen).toFixed(1)}ms normalise median=${median(norm).toFixed(1)}ms ` +
      `spread gen=[${Math.min(...gen).toFixed(1)},${Math.max(...gen).toFixed(1)}]`
    );
  }
}, 120_000);
