import { describe, it, expect } from 'vitest';
import type { StationData, TownData, TrainData, TrainGroupData } from '../types';
import {
  buildServiceGraph,
  findRoute,
  createRouteCache,
  routeBetween,
  invalidateRoutes,
  MAX_TRANSFERS,
  destinationWeights,
  pickDestination,
  addWaiting,
  totalWaiting,
  boardFromStation,
  type PassengerCohort,
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

describe('行き先の選び方(重力モデル)', () => {
  const stations = new Map<string, StationData>([
    ['A', { id: 'A', name: 'A', cells: [], center: { x: 0, z: 0 }, platformDoors: 'none' }],
    ['near', { id: 'near', name: 'near', cells: [], center: { x: 5, z: 0 }, platformDoors: 'none' }],
    ['far', { id: 'far', name: 'far', cells: [], center: { x: 30, z: 0 }, platformDoors: 'none' }],
  ]);
  const towns: TownData[] = [
    { id: 'tn', name: '近町', centre: { x: 5, z: 0 }, population: 3000 },
    { id: 'tf', name: '遠町', centre: { x: 30, z: 0 }, population: 3000 },
  ];

  it('出発駅自身は行き先候補に入らない', () => {
    const weights = destinationWeights('A', stations, towns, () => true);
    expect(weights.map(w => w.stationId)).not.toContain('A');
  });

  it('同じ規模の街なら近い駅のほうが重みが大きい', () => {
    const weights = destinationWeights('A', stations, towns, () => true);
    const near = weights.find(w => w.stationId === 'near')!;
    const far = weights.find(w => w.stationId === 'far')!;
    expect(near.weight).toBeGreaterThan(far.weight);
  });

  it('経路が無い駅は行き先候補から外れる(列車が行かない駅には客が向かわない)', () => {
    const weights = destinationWeights('A', stations, towns, dest => dest !== 'far');
    expect(weights.map(w => w.stationId)).toEqual(['near']);
  });

  it('重みに応じて行き先を1つ選ぶ', () => {
    const weights = [
      { stationId: 'p', weight: 1 },
      { stationId: 'q', weight: 3 },
    ];
    expect(pickDestination(weights, () => 0.1)).toBe('p'); // 先頭25%はp
    expect(pickDestination(weights, () => 0.9)).toBe('q');
    expect(pickDestination([], () => 0.5)).toBeNull();
  });
});

describe('待ち客のコホート', () => {
  it('同じ行き先の客は1つの塊にまとまる', () => {
    const cohorts: PassengerCohort[] = [];
    addWaiting(cohorts, 'C', 3);
    addWaiting(cohorts, 'C', 2.5);
    expect(cohorts).toEqual([{ destinationId: 'C', count: 5.5 }]);
  });

  it('待ち人数の合計を数える', () => {
    expect(totalWaiting([{ destinationId: 'C', count: 2 }, { destinationId: 'D', count: 3 }])).toBe(5);
  });

  it('乗れる行き先の客だけを、定員の空きまで乗せる', () => {
    const cohorts: PassengerCohort[] = [
      { destinationId: 'C', count: 10 },
      { destinationId: 'D', count: 10 },
    ];
    // Dへ向かう客だけがこの列車に乗れる。空きは4人。
    const boarded = boardFromStation(cohorts, dest => dest === 'D', 4);
    expect(boarded).toEqual([{ destinationId: 'D', count: 4 }]);
    expect(cohorts).toEqual([
      { destinationId: 'C', count: 10 },
      { destinationId: 'D', count: 6 },
    ]);
  });

  it('乗客は整数単位で乗り、端数は駅に残る', () => {
    const cohorts: PassengerCohort[] = [{ destinationId: 'D', count: 3.7 }];
    const boarded = boardFromStation(cohorts, () => true, 100);
    expect(boarded).toEqual([{ destinationId: 'D', count: 3 }]);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].count).toBeCloseTo(0.7);
  });

  it('空きが無ければ誰も乗れない', () => {
    const cohorts: PassengerCohort[] = [{ destinationId: 'D', count: 10 }];
    expect(boardFromStation(cohorts, () => true, 0)).toEqual([]);
    expect(totalWaiting(cohorts)).toBe(10);
  });

  it('乗り切った塊は消える', () => {
    const cohorts: PassengerCohort[] = [{ destinationId: 'D', count: 2 }];
    boardFromStation(cohorts, () => true, 100);
    expect(cohorts).toEqual([]);
  });
});
