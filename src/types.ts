import type { LineMode } from './sim/groups';
export type TrainType = 'commuter' | 'express';
/**
 * 'substation'(変電所、PM4)は車庫と同じくrailMapのセル1つとして持つ(専用のMapを
 * 別途作らない)。電化railセルに8近傍で隣接する空セルにのみ設置できる
 * (construction.tsのapplySubstation参照)。
 */
export type CellType = 'rail' | 'station' | 'depot' | 'substation';

/**
 * 軌間(mm)。PM2(progress/play-modes-plan.md)。基本ラインナップ(rules.gauge=true)は
 * 1067(狭軌)と1435(標準軌)の2種。extendedGauges=trueのリアリスティックのみ
 * 762(特殊狭軌)・1372(馬車軌間)を加えた4種を選べる。
 */
export type RailGauge = 762 | 1067 | 1372 | 1435;

/** 建設時の既定軌間(狭軌)。省略されたセル・列車はこの値として扱う(rules.gauge=true時)。 */
export const DEFAULT_GAUGE: RailGauge = 1067;

/**
 * 列車の動力方式(PM2/PM3)。気動車はどのセルでも走行可。
 * 'electric'は直流専用車(PM2からの既存名称、以後は直流専用の意味に固定する)、
 * 'electric-ac'は交流専用車、'electric-acdc'は交直流両用車(PM3、rules.electrification
 * が'boundaries'以上のときのみ選べる。'modes'段階は直流のみのため従来どおり'electric'一択)。
 */
export type TrainPower = 'diesel' | 'electric' | 'electric-ac' | 'electric-acdc';

/**
 * 立体交差の層。正=高架(uppers[1..3]、高さL*OVERPASS_HEIGHT)、負=地下(P8a、
 * 地表から相対深さ|L|*OVERPASS_HEIGHT)。0は地平そのもの(CellData本体)であり
 * このunionには含めない。uppers/StationData.cells[].layer/ramp.baseはすべて
 * このLevelを符号対称に受け付ける(progress/underground-design.md)。
 */
export type Level = -3 | -2 | -1 | 1 | 2 | 3;

// 地形。平地は既定値のため Map には載せず、terrainField.tsのterrainTypeAt()が'grass'を返す。
export type TerrainType = 'water' | 'mountain';

export interface CellData {
  type: CellType;
  connections?: number;
  stationId?: string;
  rotation?: number;
  signalDir?: number;
  // ★追加: 水上の橋・山岳のトンネル(描画用のフラグ)。costOfPathの倍率とは別に、
  // applyRailPathがterrainを見て設定する。
  // 注意: この`bridge`は「水上を渡る線路の見た目・コスト倍率」を表すフラグであり、
  // 立体交差(橋桁)を表す`upper`とは別物(紛らわしいが命名の経緯上そのまま)。
  bridge?: boolean;
  /**
   * トンネル(P7b: 標高を持つように一般化)。地上の線路が、勾配追従では建設できない
   * 高い地形の区間を、進入時の線路標高(height)を保った定高さの区間として貫くときに付く。
   * 坑口・内部判定(sim/tunnel.ts)は「コーナー標高 vs この height」で行う(旧・
   * mountain-vs-0の一般化)。旧セーブ(v15未満)のtunnel:trueはpersistence.tsの移行処理で
   * height:0(=地表)へ読み替える。
   */
  tunnel?: { height: number };
  /**
   * 立体交差(高架)の線路。地平側(connections)とは接続しない別の線路。
   * キーは高架のレベル(1〜3、高さは L*OVERPASS_HEIGHT)。construction.ts の
   * applyElevatedPath で高架線の橋桁セルにのみ設定される(直角に線路を敷いただけでは
   * 自動生成されない。平面交差にする場合は connections へ OR するだけで済ませ、
   * uppers は作らない)。異なるレベルの桁は互いに独立して同一セルに併存できる
   * (レベル2の桁の下をレベル1の桁が通る、等)。
   * 列車には層を持たせない。「そのセルにどちら向きで入ったか」(進入元へ戻るビットが
   * connectionsとuppers[L].connectionsのどれに立っているか)で一意に決まるため。
   *
   * stationId: このレベルの橋桁が「高架駅のホーム」である場合にのみ設定する。
   * 高架駅セルの判定は「uppers[L]を持ち、かつ uppers[L].stationId がある」こと。
   * stationIdが無いuppers[L](undefined)は単なる橋桁(駅ではない)を意味し、
   * 後段(予約のisSafeWaitingPoint等)では停止不可の扱いになる想定。
   *
   * 旧セーブ(v12以前)の`upper`はuppers[1]へ移行する(persistence.ts参照)。
   */
  uppers?: Partial<Record<Level, { connections: number; stationId?: string }>>;
  /**
   * 坂セル(applyElevatedPathが高架線の地平/下位レベルに繋がる/行き止まりの端に付ける)
   * であることを示す。dirは登り方向(上位側へ向かう8方向ビット)。
   * セル自体は従来どおりbaseレベルの線路(base=0なら地平connections、base≥1なら
   * uppers[base].connections)を持ったまま、この坂情報が付く。
   * baseは坂の下側レベル(省略時0=地平)。levelは坂の中でのどちら寄りか:
   * 1=下段(OVERPASS_HEIGHT/3)、2=上段(OVERPASS_HEIGHT*2/3)。1段差(base→base+1)は
   * 坂2セル(level1→level2)+橋桁(0セル以上)という構成になり、
   * base→level1→level2→base+1と高さが3段階でつながる。
   * 既存の高架へ継ぎ足す端には坂を作らない(高架のまま続く)。
   * 旧セーブにはlevel/baseが無く、読み出しは常に (cell.ramp?.level ?? 2)・
   * (cell.ramp?.base ?? 0) で行う(旧データは1セルの急な坂だったため、
   * 桁側の高さに近いlevel2扱いにする)。
   */
  ramp?: { dir: number; level?: 1 | 2; base?: number };
  /**
   * 軌間(PM2)。省略時は「概念なし(rules.gauge=false)」または「1067mm扱い(rules.gauge=true)」
   * のいずれか(呼び出し側がrules.gaugeを見て解釈する。gameRules.tsのeffectiveGauge参照)。
   * 高架(uppers)・地下は本セルと軌間を共有する単純化とする(セル単位でしか持たない。
   * 立体交差した別レベルの線路が異なる軌間を持つケースはPM2のスコープ外)。
   */
  gauge?: RailGauge;
  /**
   * 電化(PM2/PM3)。PM2時点ではboolean(ON/OFF、直流前提)のみだったが、PM3で
   * 交流を追加し'dc'|'ac'|booleanのunionへ拡張した。旧セーブ・'modes'段階のUIが
   * 書き込むlegacyの`true`は「直流」を意味する(gameRules.tsのelectrificationOfで
   * 正規化する)。省略時は非電化。'ac'はrules.electrificationが'boundaries'以上の
   * ときのみUIから書き込まれる。
   */
  electrified?: 'dc' | 'ac' | boolean;
}

export type PlatformDoorType = 'none' | 'standard' | 'fullscreen';

export interface StationData {
  id: string;
  name: string;
  /**
   * layer: このセルが地平(0、省略時の既定)か高架(1〜3、立体交差の高架ホーム、
   * レベルはL*OVERPASS_HEIGHTの高さ)かを示す。1つの駅IDに地平ホーム群
   * (layer未設定/0)と各レベルの高架ホーム群が複数ぶら下がることがある
   * (立体交差の十字乗り換え駅)。
   */
  cells: { x: number, z: number, layer?: 0 | Level }[];
  center: { x: number, z: number };
  platformDoors: PlatformDoorType;
}

export interface TownData {
  id: string;
  /** 町名(生成時に決まる。旧セーブには無いため移行処理で補う)。 */
  name: string;
  centre: { x: number, z: number };
  population: number;
}

export interface TrainData {
  id: string;
  x: number;
  z: number;
  schedule: string[];
  scheduleIndex: number;
  status: 'stored' | 'running';
  // 編成両数(1〜8)。旧セーブ(v6以前)には存在しないため、persistenceの移行処理でcars=2を補う。
  cars: number;
  // 折返し運転で運行表を辿る向き(1=順方向、-1=逆方向)。環状運転では常に1。
  // 旧セーブには存在しないため、読み出しは常に (scheduleDirection ?? 1) で行う。
  scheduleDirection?: 1 | -1;
  // 所属する運用グループのid。未所属(単独運用)はundefined。
  // グループに所属している間は schedule ではなくグループの運行表に従う。
  groupId?: string;
  /** 軌間(PM2)。購入時に車庫セルの軌間を継承する。旧セーブ・rules.gauge=falseでは省略。 */
  gauge?: RailGauge;
  /** 動力方式(PM2)。省略時は気動車扱い(どこでも走行可)。 */
  power?: TrainPower;
}

/**
 * 運用グループ(軽量なグループダイヤ)。
 * 運行表をグループで共有し、発車間隔を設定すると駅で自動的に等間隔運転になる。
 * 詳細は sim/groups.ts を参照。
 */
export interface TrainGroupData {
  id: string;
  name: string;
  /** グループで共有する停車駅の並び */
  schedule: string[];
  /** 発車間隔(シミュレーション秒)。0なら等間隔化しない */
  headwaySeconds: number;
  /** ラインカラー(車両の帯とUIのバッジに使う) */
  colour: string;
  /**
   * 走らせ方。'loop'は環状運転(末尾の次は先頭)、'shuttle'は折返し運転(終端で向きを反転)。
   * 旧セーブには存在しないため、読み出しは常に (mode ?? 'loop') で行う。
   */
  mode?: LineMode;
}

export const RAIL_COLOUR = '#555555';
export const STATION_COLOUR = '#ffaa00';
export const DEPOT_COLOUR = '#225588';
export const SIGNAL_COLOUR = '#ff3333';
export const TRAIN_COLOUR = '#FFFFFF';
export const SELECTED_TRAIN_COLOUR = '#ff0055'; 
export const GROUND_COLOUR = '#e0e0e0';