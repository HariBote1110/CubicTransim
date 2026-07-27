// 駅テンプレート設置UIの向き(quarterTurns)まわりの純粋関数。
// Reactの外に切り出し、状態遷移だけを単独でテストできるようにする。
import type { StationTemplate } from '../sim/stationTemplates';

export type QuarterTurns = 0 | 1 | 2 | 3;

/** Rキーで呼ぶ想定の状態遷移。0→1→2→3→0と時計回りに一周する。 */
export function cycleQuarterTurns(current: QuarterTurns): QuarterTurns {
  return ((current + 1) % 4) as QuarterTurns;
}

export const QUARTER_TURN_LABEL: Record<QuarterTurns, string> = {
  0: '北',
  1: '東',
  2: '南',
  3: '西',
};

/** 起動時に選ばれる既定のテンプレート(先頭)。 */
export const defaultTemplateId = (templates: StationTemplate[]): string | null =>
  templates[0]?.id ?? null;
