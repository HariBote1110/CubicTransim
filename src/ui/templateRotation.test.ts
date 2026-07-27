import { describe, expect, it } from 'vitest';
import { cycleQuarterTurns } from './templateRotation';

describe('cycleQuarterTurns', () => {
  it('0→1→2→3→0と時計回りに一周する', () => {
    expect(cycleQuarterTurns(0)).toBe(1);
    expect(cycleQuarterTurns(1)).toBe(2);
    expect(cycleQuarterTurns(2)).toBe(3);
    expect(cycleQuarterTurns(3)).toBe(0);
  });
});
