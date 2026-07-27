import { describe, it, expect } from 'vitest';
import type { TrainData, TrainGroupData } from '../types';
import {
  buildServiceGraph,
  findRoute,
  createRouteCache,
  routeBetween,
  invalidateRoutes,
  MAX_TRANSFERS,
} from './passengers';

const train = (id: string, schedule: string[], groupId?: string): TrainData => ({
  id, x: 0, z: 0, schedule, scheduleIndex: 0, status: 'running', cars: 2, groupId,
});

const group = (id: string, schedule: string[]): TrainGroupData => ({
  id, name: id, schedule, headwaySeconds: 0, colour: '#fff',
});

describe('サービス網の構築', () => {
  it('運行表の連続する駅どうしが双方向の辺になる', () => {
    const graph = buildServiceGraph([train('t1', ['A', 'B', 'C'])], []);
    expect(graph.get('A')?.map(e => e.to)).toEqual(['B']);
    expect(graph.get('B')?.map(e => e.to).sort()).toEqual(['A', 'C']);
    expect(graph.get('C')?.map(e => e.to)).toEqual(['B']);
  });

  it('グループに所属する列車はグループの共有運行表を使う', () => {
    const trains = [train('t1', ['X'], 'g1')];
    const graph = buildServiceGraph(trains, [group('g1', ['A', 'B'])]);
    expect(graph.get('A')?.map(e => e.to)).toEqual(['B']);
    // 列車自身の運行表(['X'])は使われない
    expect(graph.has('X')).toBe(false);
  });

  it('同じグループの列車が複数いても辺は重複しない', () => {
    const trains = [train('t1', [], 'g1'), train('t2', [], 'g1')];
    const graph = buildServiceGraph(trains, [group('g1', ['A', 'B'])]);
    expect(graph.get('A')).toHaveLength(1);
  });

  it('車庫で待機中(stored)の列車は運行していないので辺を作らない', () => {
    const stored: TrainData = { ...train('t1', ['A', 'B']), status: 'stored' };
    expect(buildServiceGraph([stored], []).size).toBe(0);
  });

  it('辺には由来する系統(lineId)が入る', () => {
    const graph = buildServiceGraph([train('t1', ['A', 'B'], 'g1')], [group('g1', ['A', 'B'])]);
    expect(graph.get('A')?.[0].lineId).toBe('g1');
  });
});

describe('経路探索', () => {
  it('同一系統で直通できるなら乗換なしの経路になる', () => {
    const graph = buildServiceGraph([train('t1', ['A', 'B', 'C'])], []);
    const route = findRoute(graph, 'A', 'C');
    expect(route).not.toBeNull();
    expect(route!.legs).toHaveLength(1);
    expect(route!.legs[0]).toEqual({ lineId: 't1', from: 'A', to: 'C' });
    expect(route!.hops).toBe(2);
  });

  it('乗換が必要なら乗換駅で区切った複数のlegになる', () => {
    const trains = [train('t1', ['A', 'B'], 'g1'), train('t2', ['B', 'C'], 'g2')];
    const groups = [group('g1', ['A', 'B']), group('g2', ['B', 'C'])];
    const route = findRoute(buildServiceGraph(trains, groups), 'A', 'C');
    expect(route!.legs).toEqual([
      { lineId: 'g1', from: 'A', to: 'B' },
      { lineId: 'g2', from: 'B', to: 'C' },
    ]);
    expect(route!.transfers).toBe(1);
  });

  it('乗換の少ない経路を、遠回りでも優先する', () => {
    // g1 は A→B→C→D と直通、g2/g3 は A→X→D だが乗換が要る
    const groups = [group('g1', ['A', 'B', 'C', 'D']), group('g2', ['A', 'X']), group('g3', ['X', 'D'])];
    const trains = [train('t1', [], 'g1'), train('t2', [], 'g2'), train('t3', [], 'g3')];
    const route = findRoute(buildServiceGraph(trains, groups), 'A', 'D');
    expect(route!.transfers).toBe(0);
    expect(route!.hops).toBe(3);
  });

  it('繋がっていない駅どうしは経路なし(null)', () => {
    const graph = buildServiceGraph([train('t1', ['A', 'B'])], []);
    expect(findRoute(graph, 'A', 'Z')).toBeNull();
  });

  it('乗換回数の上限を超える経路は採用しない', () => {
    // 1系統1区間ずつのリレーで、A→Eには乗換3回が必要
    const groups = [
      group('g1', ['A', 'B']), group('g2', ['B', 'C']),
      group('g3', ['C', 'D']), group('g4', ['D', 'E']),
    ];
    const trains = groups.map((g, i) => train(`t${i}`, [], g.id));
    const graph = buildServiceGraph(trains, groups);
    expect(MAX_TRANSFERS).toBe(2);
    expect(findRoute(graph, 'A', 'D')).not.toBeNull(); // 乗換2回
    expect(findRoute(graph, 'A', 'E')).toBeNull(); // 乗換3回
  });

  it('出発駅と目的駅が同じなら空の経路', () => {
    const graph = buildServiceGraph([train('t1', ['A', 'B'])], []);
    expect(findRoute(graph, 'A', 'A')).toEqual({ legs: [], hops: 0, transfers: 0 });
  });
});

describe('経路キャッシュ', () => {
  it('同じ駅ペアの2回目は同じ経路オブジェクトを返す(探索を繰り返さない)', () => {
    const graph = buildServiceGraph([train('t1', ['A', 'B', 'C'])], []);
    const cache = createRouteCache();
    const first = routeBetween(cache, graph, 'A', 'C');
    const second = routeBetween(cache, graph, 'A', 'C');
    expect(second).toBe(first);
  });

  it('経路なしの結果もキャッシュする(毎回探索し直さない)', () => {
    const graph = buildServiceGraph([train('t1', ['A', 'B'])], []);
    const cache = createRouteCache();
    expect(routeBetween(cache, graph, 'A', 'Z')).toBeNull();
    expect(cache.size).toBe(1);
  });

  it('無効化すると次回は探索し直す', () => {
    const cache = createRouteCache();
    const before = routeBetween(cache, buildServiceGraph([train('t1', ['A', 'B', 'C'])], []), 'A', 'C');
    invalidateRoutes(cache);
    expect(cache.size).toBe(0);
    const after = routeBetween(cache, buildServiceGraph([train('t1', ['A', 'B', 'C'])], []), 'A', 'C');
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
  });
});
