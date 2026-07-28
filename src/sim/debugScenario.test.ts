import { describe, expect, it } from 'vitest';
import { toKey } from '../utils';
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

  it('編成長のための余地がある駅外の線路から走り始める', () => {
    const scenario = createDebugScenario();

    expect(scenario.trains.map(train => train.x).sort((a, b) => a - b)).toEqual([-5, 5]);
    for (const train of scenario.trains) {
      expect(scenario.railMap.get(toKey(train.x, train.z))?.type).toBe('rail');
    }
  });
});
