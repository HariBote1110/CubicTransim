import { describe, expect, it } from 'vitest';
import { createDebugScenario } from './debugScenario';

describe('createDebugScenario', () => {
  it('坂・高架・往復列車を含む起動時確認用の世界を作る', () => {
    const scenario = createDebugScenario();

    expect(scenario.stations.size).toBe(2);
    expect(scenario.trains).toHaveLength(2);
    expect(Array.from(scenario.railMap.values()).some(cell => !!cell.ramp)).toBe(true);
    expect(Array.from(scenario.railMap.values()).some(cell => !!cell.uppers?.[1])).toBe(true);
    expect(scenario.trains.every(train => train.schedule.length === 2)).toBe(true);
  });
});
