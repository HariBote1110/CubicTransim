import { describe, expect, it } from 'vitest';
import {
  estimateVisibleChunkCount, budgetRatio, farViewStageForRatio, farViewStageForViewRadius,
  FAR_VIEW_CHUNK_BUDGET, FAR_VIEW_DIM_START_RATIO, FAR_VIEW_HIDE_RATIO,
} from './farView';
import { visibleChunkRange } from './terrainChunks';

describe('estimateVisibleChunkCount: visibleChunkRangeを呼ばずにチャンク数を見積もる', () => {
  it('halfExtentを十分大きく取ったとき、実際のvisibleChunkRangeの長さ以上になる(上限側の見積もり)', () => {
    const viewRadiusCells = 200;
    const halfExtent = 100000; // クランプが効かないよう十分大きく
    const actual = visibleChunkRange({ x: 0, z: 0 }, viewRadiusCells, halfExtent, 1);
    expect(estimateVisibleChunkCount(viewRadiusCells, 1)).toBeGreaterThanOrEqual(actual.length);
  });

  it('半径が大きいほど単調に増える', () => {
    expect(estimateVisibleChunkCount(1000)).toBeGreaterThan(estimateVisibleChunkCount(100));
  });

  it('負の半径は0として扱う(負数のまま計算して壊れない)', () => {
    expect(estimateVisibleChunkCount(-10)).toBe(estimateVisibleChunkCount(0));
  });
});

describe('budgetRatio / farViewStageForRatio', () => {
  it('予算未満はnormal、予算に近づくとdimmed、超えるとhiddenになる', () => {
    expect(farViewStageForRatio(0)).toBe('normal');
    expect(farViewStageForRatio(FAR_VIEW_DIM_START_RATIO - 0.01)).toBe('normal');
    expect(farViewStageForRatio(FAR_VIEW_DIM_START_RATIO)).toBe('dimmed');
    expect(farViewStageForRatio(FAR_VIEW_HIDE_RATIO - 0.01)).toBe('dimmed');
    expect(farViewStageForRatio(FAR_VIEW_HIDE_RATIO)).toBe('hidden');
    expect(farViewStageForRatio(5)).toBe('hidden');
  });

  it('budgetRatioは件数/予算(予算0は無限大扱い)', () => {
    expect(budgetRatio(50, 100)).toBeCloseTo(0.5, 9);
    expect(budgetRatio(0, 0)).toBe(0);
    expect(budgetRatio(1, 0)).toBe(Infinity);
  });
});

describe('farViewStageForViewRadius: 実際のズームで大写しの全図ズームアウトがhiddenになる', () => {
  it('通常の可視半径(数十セル)はnormal', () => {
    expect(farViewStageForViewRadius(30)).toBe('normal');
  });

  it('16385マップ(halfExtent=8192)を全図表示するのに近い可視半径はhidden', () => {
    expect(farViewStageForViewRadius(8192)).toBe('hidden');
  });

  it('予算ちょうどの境界でチャンク数がFAR_VIEW_CHUNK_BUDGETを跨ぐ', () => {
    // estimateVisibleChunkCountが予算未満から予算以上へ切り替わる半径を探し、
    // その前後でstageがnormal/dimmed寄りからhiddenへ変わることを確認する。
    let radius = 0;
    while (estimateVisibleChunkCount(radius) < FAR_VIEW_CHUNK_BUDGET) radius += 32;
    expect(farViewStageForViewRadius(radius)).toBe('hidden');
    expect(farViewStageForViewRadius(radius - 32)).not.toBe('hidden');
  });
});
