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
import type { CellData, StationData, TrainData, TrainGroupData } from '../types';
import { calculateRoute } from './pathfinding';

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

// --- 運行モード(路線の走らせ方) ---

/**
 * 路線の走らせ方。
 *  - 'loop':    環状運転。運行表の末尾まで行ったら先頭に戻る(従来の挙動)。
 *  - 'shuttle': 折返し運転。終端で向きを反転して来た道を戻る。行き止まりの
 *               路線で「終端から先頭へワープするような経路」を組まなくて済む。
 */
export type LineMode = 'loop' | 'shuttle';

/** 運行表上の現在位置(何番目の停車駅を、どちら向きに辿っているか)。 */
export interface StopCursor {
  index: number;
  /** 1なら運行表の順方向、-1なら逆方向(折返し運転でのみ-1になる)。 */
  direction: 1 | -1;
}

/** 次の停車駅の位置。停車駅が1つ以下なら動かない。 */
export function nextStop(cursor: StopCursor, stopCount: number, mode: LineMode): StopCursor {
  if (stopCount <= 1) return cursor;

  if (mode === 'loop') {
    return { index: (cursor.index + 1) % stopCount, direction: 1 };
  }

  // 折返し: 端に着いたら向きを反転してから1つ進む。
  const direction: 1 | -1 =
    (cursor.direction === 1 && cursor.index >= stopCount - 1) ? -1 :
    (cursor.direction === -1 && cursor.index <= 0) ? 1 :
    cursor.direction;

  return { index: cursor.index + direction, direction };
}

/**
 * 「この列車がこの先(今の片道で)停まる駅」の並び。現在地は含まない。
 *
 * 旅客の乗車判定に使う。折返し運転では終端で向きが変わるまで ── つまり今の片道ぶん ──
 * だけを返す。折り返した先まで含めてしまうと、目的地と逆向きに発車する列車にも
 * 乗ってしまい、わざわざ終端まで往復することになる。
 * 環状運転では向きが変わらないので一周ぶんを返す。
 */
export function stopsOnCurrentRun(schedule: string[], cursor: StopCursor, mode: LineMode): string[] {
  if (schedule.length <= 1) return [];

  const stops: string[] = [];
  let current = cursor;
  for (let i = 0; i < schedule.length; i++) {
    const next = nextStop(current, schedule.length, mode);
    // 折返し: 1歩目で向きが反転する(=終端にいる)場合はその向きで走り切るので続行し、
    // 途中で向きが変わったらそこが今の片道の終わり。
    if (i > 0 && next.direction !== current.direction) break;
    stops.push(schedule[next.index]);
    current = next;
  }
  return stops;
}

// --- 実績の運転間隔 ---

/** 1つの「路線×駅」について保持する実測サンプル数。 */
export const INTERVAL_SAMPLE_LIMIT = 5;

/** 「路線×駅」ごとの、実際に測れた発車間隔(秒)の直近サンプル。 */
export type IntervalSamples = Map<string, number[]>;

/**
 * 発車のたびに、前回の発車からの間隔を記録する。
 * 設定した発車間隔(headway)どおりに走れているかを画面に出すために使う
 * ── 待ち合わせや信号待ちで実際には広がることがあるため、設定値だけでは分からない。
 */
export function recordInterval(
  intervals: IntervalSamples,
  groupId: string,
  stationId: string,
  lastDepartureElapsed: number | undefined,
  nowElapsed: number
): void {
  if (lastDepartureElapsed === undefined) return;
  const gap = nowElapsed - lastDepartureElapsed;
  if (!(gap > 0)) return;

  const key = departureKey(groupId, stationId);
  const samples = intervals.get(key) ?? [];
  samples.push(gap);
  intervals.set(key, samples.slice(-INTERVAL_SAMPLE_LIMIT));
}

/** その路線の平均運転間隔(秒)。サンプルが1つも無ければ null。 */
export function averageInterval(intervals: IntervalSamples, groupId: string): number | null {
  const prefix = `${groupId}|`;
  let sum = 0;
  let count = 0;
  for (const [key, samples] of intervals) {
    if (!key.startsWith(prefix)) continue;
    for (const gap of samples) {
      sum += gap;
      count++;
    }
  }
  return count === 0 ? null : sum / count;
}

// --- 行き止まり路線の判定 ---

/**
 * 終端から始発へ戻る回送が、路線を一通り走る距離に対してこの割合以上なら
 * 「来た道を戻っているだけ」とみなす。
 */
const SHUTTLE_SUGGESTION_RATIO = 0.9;

const legLength = (
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  fromId: string,
  toId: string
): number | null => {
  const from = stations.get(fromId);
  if (!from) return null;
  const path = calculateRoute(railMap, stations, new Set(), new Set(), {
    start: from.center,
    prev: null,
    targetStationId: toId,
    cars: 1,
  });
  return path.length === 0 ? null : path.length;
};

/**
 * この停車駅の並びは折返し運転にすべきか。
 *
 * 環状運転では最後の駅の次に先頭の駅へ向かうため、行き止まりの路線だと
 * 終端から始発まで来た道をまるごと回送することになる。その回送距離が
 * 路線を一通り走る距離に匹敵するなら折返しを勧める。
 */
export function suggestsShuttle(
  schedule: string[],
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>
): boolean {
  // 停車駅が2つ以下なら環状も折返しも同じ動きになる。
  if (schedule.length <= 2) return false;

  let forward = 0;
  for (let i = 0; i + 1 < schedule.length; i++) {
    const leg = legLength(railMap, stations, schedule[i], schedule[i + 1]);
    if (leg === null) return false; // 経路が繋がっていない路線は判断しない
    forward += leg;
  }
  if (forward <= 0) return false;

  const closing = legLength(railMap, stations, schedule[schedule.length - 1], schedule[0]);
  // 戻る経路が無いなら環状運転は成立しない。
  if (closing === null) return true;

  return closing >= forward * SHUTTLE_SUGGESTION_RATIO;
}
