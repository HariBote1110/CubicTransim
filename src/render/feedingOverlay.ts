// PM4フォローアップ: き電区間の可視化オーバーレイ。progress/play-modes-plan.md PM4実装メモ
// の続き(変電所ツール使用中だけ、地平の電化railセルを給電状態で塗り分ける)。
//
// ここは純関数(railMap/FeedingIndexから描画用のセル一覧を作るだけ)。wgpuへの供給は
// components/WebGpuFeedingOverlay.tsx が担う(WebGpuBuildPreview.tsxと同じ半透明
// メッシュチャンクのパターン)。
import type { CellData } from '../types';
import { electrificationOf } from '../sim/gameRules';
import type { FeedingIndex } from '../sim/feeding';

export type FeedingOverlayColourKind = 'powered' | 'unpowered' | 'overload' | 'substation';

export interface FeedingOverlayCell {
  x: number;
  z: number;
  colourKind: FeedingOverlayColourKind;
}

/**
 * railMap全セルを走査し、地平(level 0)の電化railセルと変電所セルのオーバーレイ色を返す。
 * 非電化のrailセルは結果に含めない(=何も描かない)。
 *
 * feedingSectionCounts(stepWorldが1tick分の在線数を数えた直近の結果、SimWorldの
 * `feedingSectionCounts`)を渡すと、容量超過区間を'overload'として塗り分ける。省略時は
 * 'powered'/'unpowered'のみを返す(overload判定はしない、design decisionどおりの
 * cheap版フォールバック)。
 */
export function buildFeedingOverlayCells(
  railMap: Map<string, CellData>,
  feeding: FeedingIndex,
  feedingSectionCounts?: Map<string, number>
): FeedingOverlayCell[] {
  const cells: FeedingOverlayCell[] = [];

  for (const [key, cell] of railMap) {
    if (cell.type === 'substation') {
      const [x, z] = key.split(',').map(Number);
      cells.push({ x, z, colourKind: 'substation' });
      continue;
    }
    if (cell.type !== 'rail' && cell.type !== 'station') continue;
    const system = electrificationOf(cell);
    if (!system) continue;

    const [x, z] = key.split(',').map(Number);
    if (!feeding.isPowered(x, z, 0)) {
      cells.push({ x, z, colourKind: 'unpowered' });
      continue;
    }

    if (feedingSectionCounts) {
      const sectionKey = feeding.sectionLoadKey(x, z, 0);
      if (sectionKey) {
        const capacity = feeding.sectionCapacity(sectionKey);
        const count = feedingSectionCounts.get(sectionKey) ?? 0;
        if (capacity > 0 && count > capacity) {
          cells.push({ x, z, colourKind: 'overload' });
          continue;
        }
      }
    }

    cells.push({ x, z, colourKind: 'powered' });
  }

  return cells;
}
