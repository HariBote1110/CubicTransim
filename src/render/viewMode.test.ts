import { describe, it, expect } from 'vitest';
import { isUndergroundView, shouldRenderLevel, isLevelDimmed } from './viewMode';

describe('isUndergroundView: 選択レベルから地下ビューかどうかを判定する', () => {
  it('レベルが負なら地下ビュー', () => {
    expect(isUndergroundView(-1)).toBe(true);
    expect(isUndergroundView(-3)).toBe(true);
  });
  it('地平・高架は地下ビューではない', () => {
    expect(isUndergroundView(0)).toBe(false);
    expect(isUndergroundView(1)).toBe(false);
    expect(isUndergroundView(3)).toBe(false);
  });
});

describe('shouldRenderLevel: そのレベルのコンテンツを描くべきか', () => {
  it('地平・高架(level>=0)は地下ビューの有無によらず常に描く', () => {
    expect(shouldRenderLevel(0, false)).toBe(true);
    expect(shouldRenderLevel(0, true)).toBe(true);
    expect(shouldRenderLevel(2, false)).toBe(true);
    expect(shouldRenderLevel(2, true)).toBe(true);
  });
  it('地下(level<0)は地下ビュー中のみ描く', () => {
    expect(shouldRenderLevel(-1, true)).toBe(true);
    expect(shouldRenderLevel(-1, false)).toBe(false);
    expect(shouldRenderLevel(-3, false)).toBe(false);
  });
});

describe('isLevelDimmed: そのレベルのコンテンツを暗くすべきか', () => {
  it('通常表示(地下ビューでない)では何も暗くしない', () => {
    expect(isLevelDimmed(0, false, 0)).toBe(false);
    expect(isLevelDimmed(2, false, 0)).toBe(false);
    expect(isLevelDimmed(-1, false, 0)).toBe(false);
  });
  it('地下ビュー中は選択中のレベル以外をすべて暗くする', () => {
    expect(isLevelDimmed(0, true, -1)).toBe(true); // 地平
    expect(isLevelDimmed(2, true, -1)).toBe(true); // 高架
    expect(isLevelDimmed(-2, true, -1)).toBe(true); // 別の地下レベル
  });
  it('地下ビュー中でも選択中のレベル自身は暗くしない', () => {
    expect(isLevelDimmed(-1, true, -1)).toBe(false);
  });
});
