import { describe, it, expect, vi } from 'vitest';
import { serialiseWorld, deserialiseWorld, emptyLedger } from '../sim/persistence';
import { applyRestoredWorldState, type RestoredWorldSetters } from './useGameLogic';

// loadGameがrestored.halfExtentをsetHalfExtentへ反映することを固定する仕様テスト。
// (Codexレビュー指摘: マップサイズが異なるセーブを読み込むと地形生成やチャンク境界が
// 旧halfExtentのまま残ってしまうバグの再発防止)
describe('applyRestoredWorldState', () => {
  it('restored.halfExtentでsetHalfExtentを呼ぶ', () => {
    const saveData = serialiseWorld(
      new Map(), new Map(), [], new Map(), new Map(), 1000, [], 42,
      { elapsed: 0 }, emptyLedger(), [], 'middle', [], [], new Map(), 0, new Map(),
      96, new Map(), 'normal', 'normal'
    );
    const restored = deserialiseWorld(saveData);
    expect(restored).not.toBeNull();
    expect(restored!.halfExtent).toBe(96);

    const setters: RestoredWorldSetters = {
      setRailMap: vi.fn(),
      setStations: vi.fn(),
      setTrains: vi.fn(),
      setMoney: vi.fn(),
      setLoan: vi.fn(),
      setTowns: vi.fn(),
      setTownDensity: vi.fn(),
      setTerrainProfile: vi.fn(),
      setGameRules: vi.fn(),
      setWorldSeed: vi.fn(),
      setHalfExtent: vi.fn(),
      setCornerDiffs: vi.fn(),
      setDebugFieldOverride: vi.fn(),
      setCurrentLedger: vi.fn(),
      setLedgerHistory: vi.fn(),
      setStopLocation: vi.fn(),
      setLines: vi.fn(),
      setServices: vi.fn(),
    };

    applyRestoredWorldState(restored!, setters);

    expect(setters.setHalfExtent).toHaveBeenCalledWith(96);
  });
});
