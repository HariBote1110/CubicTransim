// 運用グループ(軽量なグループダイヤ)。
//
// 考え方はOpenTTDの「共有オーダー + separation」に近い:
//  - 複数の列車を1つのグループにまとめ、運行表(停車駅の並び)をグループで共有する。
//    運行表を直すときに1本ずつ組み直さなくてよくなる。
//  - グループに「発車間隔(headway)」を設定すると、駅を発車するときに
//    「同じグループの列車が同じ駅を発車してから headway 秒経っているか」を見て、
//    足りなければその場で待つ。これだけで団子運転が自然にほどけ、等間隔運転になる。
//
// ゲーム内時計の絶対時刻に停車時刻を割り付ける「時刻表」方式ではないので、
// 遅延の伝播や時刻の再計算を扱う必要がなく、実装も運用も軽い。
import type { TrainData, TrainGroupData } from '../types';

/** グループに割り当てるラインカラーの候補(描画の帯とUIのバッジに使う)。 */
export const GROUP_COLOURS = [
  '#1f8fd6', // 青
  '#e2571f', // 橙
  '#34a853', // 緑
  '#a855f7', // 紫
  '#e0417a', // 桃
  '#d9a441', // 黄土
] as const;

/** 発車間隔として選べる値(シミュレーション秒)。0は等間隔化なし。 */
export const HEADWAY_CHOICES = [0, 15, 30, 45, 60, 90, 120] as const;

/** 新しいグループに割り当てる色(既存グループとなるべく重複しないように選ぶ)。 */
export function nextGroupColour(groups: TrainGroupData[]): string {
  const used = new Set(groups.map(g => g.colour));
  return GROUP_COLOURS.find(c => !used.has(c)) ?? GROUP_COLOURS[groups.length % GROUP_COLOURS.length];
}

/** 新しいグループ名(「1系統」「2系統」…のうち未使用の最小番号)。 */
export function nextGroupName(groups: TrainGroupData[]): string {
  const used = new Set(groups.map(g => g.name));
  for (let i = 1; ; i++) {
    const name = `${i}系統`;
    if (!used.has(name)) return name;
  }
}

export function findGroup(groups: TrainGroupData[], groupId: string | undefined | null): TrainGroupData | undefined {
  if (!groupId) return undefined;
  return groups.find(g => g.id === groupId);
}

/**
 * その列車が実際に従う運行表。
 * グループに所属していればグループの運行表、していなければ列車自身の運行表。
 */
export function effectiveSchedule(train: TrainData, groups: TrainGroupData[]): string[] {
  const group = findGroup(groups, train.groupId);
  return group ? group.schedule : train.schedule;
}

/** 発車時刻を記録するキー(グループ×駅)。 */
export function departureKey(groupId: string, stationId: string): string {
  return `${groupId}|${stationId}`;
}

/**
 * 発車間隔を満たすまであと何秒待つ必要があるか。0なら発車してよい。
 *
 * @param headwaySeconds       グループの発車間隔。0以下なら常に0を返す(等間隔化なし)
 * @param lastDepartureElapsed 同じグループが同じ駅を最後に発車した時刻(未記録ならundefined)
 * @param nowElapsed           現在のシミュレーション累積秒
 */
export function headwayHoldSeconds(
  headwaySeconds: number,
  lastDepartureElapsed: number | undefined,
  nowElapsed: number
): number {
  if (!(headwaySeconds > 0)) return 0;
  if (lastDepartureElapsed === undefined) return 0;
  const elapsedSince = nowElapsed - lastDepartureElapsed;
  return Math.max(0, headwaySeconds - elapsedSince);
}

/** グループに所属する列車の一覧。 */
export function membersOf(trains: TrainData[], groupId: string): TrainData[] {
  return trains.filter(t => t.groupId === groupId);
}
