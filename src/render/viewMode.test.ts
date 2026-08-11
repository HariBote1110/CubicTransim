import { describe, it, expect } from 'vitest';
import { isUndergroundView, undergroundBucketOf, isLevelDimmed, previewMeshLayerClass } from './viewMode';
import { MESH_LAYER_CLASS } from './webgpuLayer';

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

describe('undergroundBucketOf: 地下コンテンツをどのバケットへ入れるか', () => {
  // R4末: 地上ビューの地下線ゴーストが「ごちゃごちゃして見づらい」というユーザー
  // フィードバックを受け、地上ビューの地下線(このバケットの対象=線路)は完全非表示
  // (hidden)にした。駅ホームのゴースト表示(Alpha-4cの発見容易性維持)はこの関数を
  // 経由しない別経路(WebGpuStations.tsx)なので、この変更の影響を受けない。
  it('地上ビューでは、どの深さの地下も非表示(hidden)になる', () => {
    expect(undergroundBucketOf(-1, false, 0)).toBe('hidden');
    expect(undergroundBucketOf(-3, false, 2)).toBe('hidden');
  });
  it('地下ビュー中は、選択中の深さだけbright', () => {
    expect(undergroundBucketOf(-1, true, -1)).toBe('bright');
    expect(undergroundBucketOf(-2, true, -1)).toBe('dim');
    expect(undergroundBucketOf(-1, true, -3)).toBe('dim');
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

describe('previewMeshLayerClass: 建設プレビューの描画クラスを最小y座標から選ぶ', () => {
  it('すべてのセルがy>=0なら半透明(translucent)', () => {
    expect(previewMeshLayerClass(0)).toBe(MESH_LAYER_CLASS.translucent);
    expect(previewMeshLayerClass(1.5)).toBe(MESH_LAYER_CLASS.translucent);
  });
  it('いずれかのセルがy<0(地下)なら地下ゴースト(undergroundGhost)', () => {
    expect(previewMeshLayerClass(-0.1)).toBe(MESH_LAYER_CLASS.undergroundGhost);
    expect(previewMeshLayerClass(-5)).toBe(MESH_LAYER_CLASS.undergroundGhost);
  });
  it('境界y=0はtranslucent', () => {
    expect(previewMeshLayerClass(0)).toBe(MESH_LAYER_CLASS.translucent);
  });
});
