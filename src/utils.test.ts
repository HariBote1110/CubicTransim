import { describe, expect, it } from 'vitest';
import {
  DIR,
  toKey,
  fromKey,
  getDirFromVector,
  getVectorFromDir,
  getOppositeDir,
  getConstrainedPath,
} from './utils';

describe('toKey / fromKey', () => {
  it('toKeyが "x,z" 形式の文字列を返す', () => {
    expect(toKey(3, 5)).toBe('3,5');
    expect(toKey(0, 0)).toBe('0,0');
  });

  it('負の座標でも往復できる', () => {
    const cases = [
      { x: 0, z: 0 },
      { x: 3, z: -5 },
      { x: -3, z: 5 },
      { x: -7, z: -9 },
      { x: 100, z: -100 },
    ];
    for (const { x, z } of cases) {
      expect(fromKey(toKey(x, z))).toEqual({ x, z });
    }
  });
});

describe('getDirFromVector / getVectorFromDir', () => {
  const directions: Array<{ name: string; dx: number; dz: number; dir: number }> = [
    { name: 'N', dx: 0, dz: -1, dir: DIR.N },
    { name: 'NE', dx: 1, dz: -1, dir: DIR.NE },
    { name: 'E', dx: 1, dz: 0, dir: DIR.E },
    { name: 'SE', dx: 1, dz: 1, dir: DIR.SE },
    { name: 'S', dx: 0, dz: 1, dir: DIR.S },
    { name: 'SW', dx: -1, dz: 1, dir: DIR.SW },
    { name: 'W', dx: -1, dz: 0, dir: DIR.W },
    { name: 'NW', dx: -1, dz: -1, dir: DIR.NW },
  ];

  it.each(directions)('$name: ベクトルから方向ビットに変換できる', ({ dx, dz, dir }) => {
    expect(getDirFromVector(dx, dz)).toBe(dir);
  });

  it.each(directions)('$name: 方向ビットからベクトルに変換できる', ({ dx, dz, dir }) => {
    expect(getVectorFromDir(dir)).toEqual({ x: dx, z: dz });
  });

  it.each(directions)('$name: ベクトル→方向→ベクトルが往復整合する', ({ dx, dz }) => {
    const dir = getDirFromVector(dx, dz);
    expect(getVectorFromDir(dir)).toEqual({ x: dx, z: dz });
  });

  it('該当しないベクトルは 0 を返す', () => {
    expect(getDirFromVector(0, 0)).toBe(0);
    expect(getDirFromVector(2, 2)).toBe(0);
  });

  it('該当しない方向ビットは原点ベクトルを返す', () => {
    expect(getVectorFromDir(0)).toEqual({ x: 0, z: 0 });
  });
});

describe('getOppositeDir', () => {
  const pairs: Array<[number, number]> = [
    [DIR.N, DIR.S],
    [DIR.NE, DIR.SW],
    [DIR.E, DIR.W],
    [DIR.SE, DIR.NW],
    [DIR.S, DIR.N],
    [DIR.SW, DIR.NE],
    [DIR.W, DIR.E],
    [DIR.NW, DIR.SE],
  ];

  it.each(pairs)('%s の反対方向は %s', (dir, opposite) => {
    expect(getOppositeDir(dir)).toBe(opposite);
  });

  it('8方向すべてで2回適用すると元に戻る（対合）', () => {
    for (const dirName of Object.keys(DIR) as Array<keyof typeof DIR>) {
      const dir = DIR[dirName];
      expect(getOppositeDir(getOppositeDir(dir))).toBe(dir);
    }
  });

  it('該当しない方向は 0 を返す', () => {
    expect(getOppositeDir(0)).toBe(0);
  });
});

describe('getConstrainedPath', () => {
  it('start と end が同じ場合は単一セルのパスを返す', () => {
    const path = getConstrainedPath({ x: 0, z: 0 }, { x: 0, z: 0 });
    expect(path).toEqual([{ x: 0, z: 0 }]);
  });

  it('水平方向のパスを生成する', () => {
    const path = getConstrainedPath({ x: 0, z: 0 }, { x: 5, z: 0 });
    expect(path).toEqual([
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 2, z: 0 },
      { x: 3, z: 0 },
      { x: 4, z: 0 },
      { x: 5, z: 0 },
    ]);
  });

  it('水平方向（負方向）のパスを生成する', () => {
    const path = getConstrainedPath({ x: 5, z: 0 }, { x: 0, z: 0 });
    expect(path).toEqual([
      { x: 5, z: 0 },
      { x: 4, z: 0 },
      { x: 3, z: 0 },
      { x: 2, z: 0 },
      { x: 1, z: 0 },
      { x: 0, z: 0 },
    ]);
  });

  it('垂直方向のパスを生成する', () => {
    const path = getConstrainedPath({ x: 0, z: 0 }, { x: 0, z: 5 });
    expect(path).toEqual([
      { x: 0, z: 0 },
      { x: 0, z: 1 },
      { x: 0, z: 2 },
      { x: 0, z: 3 },
      { x: 0, z: 4 },
      { x: 0, z: 5 },
    ]);
  });

  it('45度斜め方向のパスを生成する', () => {
    const path = getConstrainedPath({ x: 0, z: 0 }, { x: 5, z: 5 });
    expect(path).toEqual([
      { x: 0, z: 0 },
      { x: 1, z: 1 },
      { x: 2, z: 2 },
      { x: 3, z: 3 },
      { x: 4, z: 4 },
      { x: 5, z: 5 },
    ]);
  });

  it('45度斜め方向（負方向）のパスを生成する', () => {
    const path = getConstrainedPath({ x: 0, z: 0 }, { x: -5, z: -5 });
    expect(path).toEqual([
      { x: 0, z: 0 },
      { x: -1, z: -1 },
      { x: -2, z: -2 },
      { x: -3, z: -3 },
      { x: -4, z: -4 },
      { x: -5, z: -5 },
    ]);
  });

  it('傾きが中途半端でも横成分が優勢なら水平にスナップされる（tan=0.3）', () => {
    const path = getConstrainedPath({ x: 0, z: 0 }, { x: 10, z: 3 });
    expect(path[path.length - 1]).toEqual({ x: 10, z: 0 });
    expect(path).toHaveLength(11);
  });

  it('傾きが中途半端でも縦成分が優勢なら垂直にスナップされる（tan≈3.33）', () => {
    const path = getConstrainedPath({ x: 0, z: 0 }, { x: 3, z: 10 });
    expect(path[path.length - 1]).toEqual({ x: 0, z: 10 });
    expect(path).toHaveLength(11);
  });

  it('傾きが中間域（0.5〜2.0）なら斜め45度にスナップされる（tan=0.6）', () => {
    const path = getConstrainedPath({ x: 0, z: 0 }, { x: 10, z: 6 });
    expect(path[path.length - 1]).toEqual({ x: 10, z: 10 });
    expect(path).toHaveLength(11);
  });
});
