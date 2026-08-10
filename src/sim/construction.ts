import { toKey, getDirFromVector, getOppositeDir, getVectorFromDir, DIR } from '../utils';
import type { CellData, StationData, TownData, Level } from '../types';
import type { TerrainField } from './terrainField';
import { fieldFromMaps } from './terrainField';
import { nearestTownWithinRadius, stationNameForTown } from './towns';
import type { TownTileIndex } from './townTiles';
import { isTownBlocked, townTileAt } from './townTiles';
import {
  allowedRailConnections,
  canPlaceFlatStructure,
  pathCellConnectionDirs,
  railEdgeContinuous,
  railHeightAt,
  slopeOf,
  undergroundEdgeContinuous,
} from './slopes';

// 旧・固定長の橋(applyBridge)が使っていた上限値。自由な高架線(applyElevatedPath)には
// 上下限を設けないため実質未使用だが、economy.ts側の後方互換のため定数だけ残す。
export const MAX_BRIDGE_LENGTH = 12;

export interface ConstructionState {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
}

type Pos = { x: number; z: number };

// 駅セルの接続の軸。基本は南北(ns)か東西(ew)のどちらか一方の2方向接続にし、
// 十字に交差した駅セルだけが4方向(cross)を持つ。旧セーブの4方向固定駅とは
// このcrossが実質的に同じビット構成になる。
export type StationAxis = 'ns' | 'ew' | 'cross';

const axisBitsFor = (axis: StationAxis): number => {
  if (axis === 'ns') return DIR.N | DIR.S;
  if (axis === 'ew') return DIR.E | DIR.W;
  return DIR.N | DIR.E | DIR.S | DIR.W;
};

const hasRailOrStationCell = (railMap: Map<string, CellData>, x: number, z: number): boolean => {
  const c = railMap.get(toKey(x, z));
  return !!c && (c.type === 'rail' || c.type === 'station');
};

// 隣接する既存の線路・駅セルから軸を推測する。南北方向に隣接セルがあればns、
// 東西方向にあればew、両方あればcross(交差)。何も無ければ東西(ew)を既定にする。
const inferStationAxis = (railMap: Map<string, CellData>, x: number, z: number): StationAxis => {
  const hasNS = hasRailOrStationCell(railMap, x, z - 1) || hasRailOrStationCell(railMap, x, z + 1);
  const hasEW = hasRailOrStationCell(railMap, x - 1, z) || hasRailOrStationCell(railMap, x + 1, z);
  if (hasNS && hasEW) return 'cross';
  if (hasNS) return 'ns';
  if (hasEW) return 'ew';
  return 'ew';
};

// axisHint(ドラッグ方向のヒント)がそのセルの実状と矛盾しないかを検証する。
// - 対象セルが既存の線路/駅として何の接続も持たない(真っさらな空セル)場合は、
//   衝突しようがないのでヒントをそのまま信用する(駅スタブの初期方向を決めるのに必要)。
// - 既に何らかの接続を持つセルの場合は、ヒントの軸方向に実在の隣接線路/駅セルが
//   無ければヒントを信用しない。ヒントはポインタのドラッグ量(mousedown→mouseup)の
//   差分から作る雑な推測値でしかなく、既存の直線区間を単にクリックしただけでも
//   1セル分のブレで直交方向のヒントが立ってしまうことがある。それをそのまま
//   connectionsへORすると、実在しない直交接続が混入し、ホームが線路と直交して
//   描画される(ユーザー報告の不具合の根本原因)。一方、十字乗換駅のように実際に
//   直交する線路へ向けて意図的にドラッグしたケースはヒント方向に本物の隣接セルが
//   あるので、この検証を通過して従来通りcrossを形成できる。
const axisHintIsSupported = (
  railMap: Map<string, CellData>,
  x: number,
  z: number,
  ownConnections: number,
  hint: StationAxis
): boolean => {
  if (ownConnections === 0) return true;
  if (hint === 'ns') return hasRailOrStationCell(railMap, x, z - 1) || hasRailOrStationCell(railMap, x, z + 1);
  if (hint === 'ew') return hasRailOrStationCell(railMap, x - 1, z) || hasRailOrStationCell(railMap, x + 1, z);
  return true; // 'cross' を明示指定するのは稀な直接呼び出しのみなので無条件に許可する
};

// field省略時は空field(=すべて平地)扱いにする。既存呼び出し・既存テストとの互換のため。
const EMPTY_FIELD: TerrainField = fieldFromMaps(new Map(), new Map(), Infinity);

// townTiles省略時は空索引(=町タイル無し)扱いにする。既存呼び出し・既存テストとの互換のため。
const EMPTY_TOWN_TILES: TownTileIndex = new Map();

// 経路のどこかが家タイルに乗っているか(地平の線路は家タイルを通れない。
// 道路タイルは踏切として通過できるためisTownBlockedは道路をfalseにする)。
const pathCrossesHouseTile = (townTiles: TownTileIndex, path: Pos[]): boolean =>
  path.some(p => isTownBlocked(townTiles, p.x, p.z));

// セルが水域・非flatかどうか(駅・車庫・信号はflatにしか置けない)。P7bより、
// 「terrainTypeAt==='grass'」ではなく「コーナー標高がflat(4隅同値)かつ水域でない」で判定する。
// mountain(標高1以上)というだけでは拒否しなくなった: 平坦な高原(4隅同値の高標高セル)には
// 駅・車庫・信号を置ける(design doc 4.「mountain概念の廃止」)。水域は従来どおり常に不可。
const isBuildableGround = (field: TerrainField, x: number, z: number): boolean => {
  if (field.terrainTypeAt(x, z) === 'water') return false;
  return canPlaceFlatStructure(slopeOf(field.cellCornerHeights(x, z)));
};

// 坂(ramp)セルは従来通り「標高0の地平」にしか置けない(高架/自由な高架線の坂は、
// 地表からOVERPASS_HEIGHT単位で登る前提の描画・物理モデルなので、標高のある地面
// からの発着は想定していない)。P7bでisBuildableGroundが「flatなら任意標高で可」に
// 緩んだため、坂だけはここで明示的に標高0を要求するガードを別に用意する
// (design doc「Elevated tracks: unchanged」を維持する)。
const isFlatGroundLevelZero = (field: TerrainField, x: number, z: number): boolean =>
  isBuildableGround(field, x, z) && field.cellHeightAt(x, z) === 0;

// --- ヘルパー ---
const updateDepotRotation = (map: Map<string, CellData>, x: number, z: number) => {
  const key = toKey(x, z);
  const cell = map.get(key);
  if (!cell || cell.type !== 'depot') return;

  const neighbours = [
    { dx: 0, dz: -1, rot: 0 },
    { dx: 1, dz: 0, rot: -Math.PI / 2 },
    { dx: 0, dz: 1, rot: Math.PI },
    { dx: -1, dz: 0, rot: Math.PI / 2 },
  ];

  let bestRot = cell.rotation || 0;
  let found = false;

  for (const n of neighbours) {
    const targetKey = toKey(x + n.dx, z + n.dz);
    const targetCell = map.get(targetKey);
    if (targetCell && (targetCell.type === 'rail' || targetCell.type === 'station')) {
      bestRot = n.rot;
      found = true;
      break;
    }
  }
  if (found) {
    map.set(key, { ...cell, rotation: bestRot });
  }
};

// バグ5対策: 既存駅名を走査し、A から順に未使用の文字を割り当てる。
// 孤児駅（隣接がなくなった駅）を消しても採番が飛ばない。
// 表記は日本語に統一しているため「A駅」形式で採番する(旧セーブの
// "Station A" 形式の駅名はそのまま保持され、採番の重複判定にも影響しない)。
export const nextStationName = (stations: Map<string, StationData>): string => {
  const used = new Set(Array.from(stations.values()).map(s => s.name));
  let suffix = 1;
  // まずは A〜Z の単純な名前を試し、尽きたら数字サフィックス付きに進む
  while (true) {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      const name = suffix === 1 ? `${letter}駅` : `${letter}${suffix}駅`;
      if (!used.has(name)) return name;
    }
    suffix++;
  }
};

// 駅名を決める: pos の近く(TOWN_STATION_RADIUS以内)に町があればその町名由来
// (stationNameForTown、被り対策つき)にし、無ければ従来のA駅/B駅方式にフォールバックする。
const stationNameFor = (
  pos: Pos,
  stations: Map<string, StationData>,
  towns: TownData[]
): string => {
  const town = nearestTownWithinRadius(pos, towns);
  if (!town) return nextStationName(stations);
  const usedNames = new Set(Array.from(stations.values()).map(s => s.name));
  return stationNameForTown(town, pos, usedNames);
};

// terrainに応じたbridgeフラグ(描画用)。水域なら付く。
// 呼び出し元(applyGroundPathWithElevatedConnect/applyElevatedPathの坂セル)は
// isBuildableGroundで既にflat(かつ非水域)を要求済みのため、ここが水域を返すことは
// 実質無い(型・将来拡張のため関数自体は残す)。tunnelは地上のresolveGroundRailPlanが
// 別途決めるため、ここでは扱わない(P7bより前は「mountain=tunnel:true」を機械的に
// 付けていたが、標高を持つtunnelは経路全体の文脈が要るためこの関数の責務から外した)。
const terrainFlags = (field: TerrainField, x: number, z: number): Pick<CellData, 'bridge'> => {
  const t = field.terrainTypeAt(x, z);
  if (t === 'water') return { bridge: true };
  return { bridge: undefined };
};

// baseレベルの線路へbitsをORする。base===0は地平connections、base>0はuppers[base]。
// applyElevatedPathと、地平の線路が高架の端に自動接続する坂(applyRailPathDetailed内)の
// 両方から使う共通ヘルパー。
const orIntoBaseLevel = (existing: CellData | undefined, base: number, bits: number): CellData => {
  if (base === 0) {
    return { ...(existing ?? { type: 'rail' }), connections: (existing?.connections ?? 0) | bits };
  }
  const upperAtBase = existing?.uppers?.[base as Level];
  return {
    ...(existing ?? { type: 'rail' }),
    uppers: {
      ...(existing?.uppers ?? {}),
      [base]: { connections: (upperAtBase?.connections ?? 0) | bits, stationId: upperAtBase?.stationId },
    },
  };
};

// 既存セルにdir方向の接続を1つ足す。常に地平のconnectionsへOR(平面交差方式)。
// 直角に交差する線路は4方向接続の1セル(ダイヤモンドクロッシング)になる。
// 既存の坂(ramp)セルへ、坂の軸(dir/opposite)以外の向きの接続を追加できるかを判定する。
// 坂セルはbuildRampTrackParts(render/trackGeometry.ts)が「dir 1方向ぶんの傾斜」しか
// 描けない前提のため、そこへ別方向(直交する平面交差など)の接続が生えると、その方向は
// 高さ0の平坦な部品として誤って描かれ、宙に浮いた破片や地平線が途切れて見える不具合に
// なる(2回に分けて建設した場合、後から交差する線路を引くと起きうる)。
// これを防ぐため、坂の軸と一致しない新しい接続はブロックする(坂セルは直線専用)。
const conflictsWithExistingRamp = (existing: CellData | undefined, dir: number): boolean => {
  if (!existing?.ramp) return false;
  const axis = existing.ramp.dir | getOppositeDir(existing.ramp.dir);
  return (dir & ~axis) !== 0;
};

/**
 * path(隣接するセル列)を敷設したとき、既存の坂(ramp)セルへ軸と異なる方向の接続を
 * 追加してしまわないかを確認する。1つでも抵触すればtrueを返し、呼び出し元は
 * 建設全体をno-opにする(部分的に建設して坂を壊さないため)。
 */
const pathConflictsWithExistingRamp = (railMap: Map<string, CellData>, path: Pos[]): boolean => {
  for (let i = 0; i < path.length - 1; i++) {
    const curr = path[i];
    const next = path[i + 1];
    const dir = getDirFromVector(next.x - curr.x, next.z - curr.z);
    const oppDir = getOppositeDir(dir);
    if (conflictsWithExistingRamp(railMap.get(toKey(curr.x, curr.z)), dir)) return true;
    if (conflictsWithExistingRamp(railMap.get(toKey(next.x, next.z)), oppDir)) return true;
  }
  return false;
};

/**
 * P7b: 地上の経路1セルぶんの建設方法。
 * - 'ground': 勾配追従で建設する通常の地平セル(flat/incline)。コスト倍率の判定用に
 *   slopeを持たせる(incline は economy.ts で SLOPE_RAIL_COST_MULTIPLIER を掛ける)。
 * - 'tunnel': 勾配追従できない区間を、進入時の線路標高(height)を保った定高さで貫く。
 */
export type GroundRailCellRole =
  | { kind: 'ground'; slope: 'flat' | 'incline' }
  | { kind: 'tunnel'; height: number };

/**
 * 建設パス(隣接するセル列)を、slope-construction-design.mdの優先順位に従ってセルごとの
 * 建設方法へ解決する。建設不可(no-op)ならnullを返す。
 *
 * 1. 経路全体がslopes.pathSlopeViolations的に問題ない(全セルflat/incline+方向OK、
 *    かつ連続する辺すべて標高連続)なら、全セルgroundとして返す。
 * 2. そうでなければ、slope追従が破綻する連続区間(run)を洗い出し、runの手前にある
 *    最後のgroundセルのrailHeightAt(=entryHeight、runが経路の先頭ならそのセルの
 *    最低コーナーで代用)より、run内の各セルの地形(cellHeightAt)が高ければtunnel扱いにする。
 *    runの直後にセルがあれば、そのセルのrailHeightAtがentryHeightと一致すること
 *    (坑口で標高が繋がること)も要求する。
 * 3. run内のどれか1セルでも「entryHeightより高くない」、またはrun直後の標高が
 *    一致しない場合は、経路全体を建設不可(null)にする。
 *
 * このrunの切り出しは「連続する2セルが個別にはOKでも、共有辺の標高が繋がらない」ケース
 * (edge-discontinuous)も、下流側のセルをrunに含めることで扱う。ただし実際のTerrainField
 * (コーナーが隣接セル間で物理共有される)ではこのケースは構造的にほぼ起こらない
 * (slopes.tsのP7a実装メモ参照)。
 */
/**
 * P7d: resolveGroundRailPlanが建設不可(null)と判定した理由(UIフィードバック向け)。
 * - 'other-slope': 経路上のセルがother斜面(線路自体が敷けない形)で、かつその区間を
 *   トンネルで貫くにも地形がentryHeightより高くない
 * - 'direction-blocked': incline斜面が、経路が必要とする接続方向を許可しない
 * - 'edge-discontinuous': 隣接セル間で共有辺の標高が繋がらない(実際のTerrainFieldでは
 *   構造的にほぼ発生しない。slopes.tsのP7a実装メモ参照)
 * - 'tunnel-exit-mismatch': トンネル区間直後のセルの標高が、進入標高と一致しない
 */
export type GroundRailPlanFailureReason =
  | 'other-slope'
  | 'direction-blocked'
  | 'edge-discontinuous'
  | 'tunnel-exit-mismatch';

export interface GroundRailPlanResult {
  plan: GroundRailCellRole[] | null;
  /** planがnullのときだけ設定される、no-opになった理由。 */
  reason?: GroundRailPlanFailureReason;
}

/**
 * resolveGroundRailPlanの本体。UI向けに「なぜ建設できないか」も一緒に返す
 * (P7d)。resolveGroundRailPlan(既存のプレーンなAPI)はこの関数のplanだけを返す
 * 薄いラッパーにした(挙動は無改修)。
 */
export function resolveGroundRailPlanDetailed(field: TerrainField, path: Pos[]): GroundRailPlanResult {
  const n = path.length;
  if (n === 0) return { plan: [] };

  const corners = path.map(p => field.cellCornerHeights(p.x, p.z));
  const slopes = corners.map(c => slopeOf(c));

  // セルごとの「なぜダメか」(cellOk===trueなら未使用)。other-slopeを優先し、
  // それ以外で方向が塞がれていればdirection-blockedにする。
  const cellReason: (GroundRailPlanFailureReason | undefined)[] = slopes.map(s =>
    s.kind === 'other' ? 'other-slope' : undefined
  );
  const cellOk = path.map((_, i) => {
    const slope = slopes[i];
    if (slope.kind === 'other') return false;
    const allowed = allowedRailConnections(slope);
    const dirs = pathCellConnectionDirs(path, i);
    const ok = dirs.every(d => (allowed & d) !== 0);
    if (!ok) cellReason[i] = 'direction-blocked';
    return ok;
  });

  const badIndex = cellOk.map(ok => !ok);
  for (let i = 0; i < n - 1; i++) {
    if (!cellOk[i] || !cellOk[i + 1]) continue;
    const dir = getDirFromVector(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
    if (!railEdgeContinuous(corners[i], corners[i + 1], dir)) {
      badIndex[i + 1] = true;
      cellReason[i + 1] = 'edge-discontinuous';
    }
  }

  const roles: GroundRailCellRole[] = slopes.map(s => ({
    kind: 'ground' as const,
    slope: s.kind === 'incline' ? ('incline' as const) : ('flat' as const),
  }));

  if (!badIndex.some(Boolean)) return { plan: roles };

  let i = 0;
  while (i < n) {
    if (!badIndex[i]) {
      i++;
      continue;
    }
    const lo = i;
    let hi = i;
    while (hi + 1 < n && badIndex[hi + 1]) hi++;

    const entryHeight = lo > 0
      ? railHeightAt(field, undefined, path[lo - 1].x, path[lo - 1].z)
      : Math.min(...corners[lo]);

    // 「地形がentryHeightより高い」の判定はコーナーの最大値で行う(field.cellHeightAtの
    // 4隅min則ではない)。崖の縁のセル(例: 標高3の台地の境界セルは[0,0,3,3]のような
    // otherスロープになる)はmin則だと0になり、実際には大きくかぶさっている地形の
    // 存在を見逃してしまう。「そのセルの足元のどこかがentryHeightを超えて盛り上がって
    // いるか」を問うにはmax則のほうが適切(トンネルを掘るべき土被りの有無を表す)。
    for (let k = lo; k <= hi; k++) {
      if (Math.max(...corners[k]) <= entryHeight) {
        return { plan: null, reason: cellReason[k] ?? 'other-slope' };
      }
    }

    if (hi + 1 < n) {
      const exitHeight = railHeightAt(field, undefined, path[hi + 1].x, path[hi + 1].z);
      if (exitHeight !== entryHeight) return { plan: null, reason: 'tunnel-exit-mismatch' };
    }

    for (let k = lo; k <= hi; k++) {
      roles[k] = { kind: 'tunnel', height: entryHeight };
    }

    i = hi + 1;
  }

  return { plan: roles };
}

export function resolveGroundRailPlan(field: TerrainField, path: Pos[]): GroundRailCellRole[] | null {
  return resolveGroundRailPlanDetailed(field, path).plan;
}

// resolveGroundRailPlanの結果から、そのセルに付けるCellDataの地形フラグ(bridge/tunnel)を返す。
const cellFlagsForRole = (field: TerrainField, role: GroundRailCellRole, x: number, z: number): Pick<CellData, 'bridge' | 'tunnel'> => {
  if (role.kind === 'tunnel') return { bridge: undefined, tunnel: { height: role.height } };
  return { ...terrainFlags(field, x, z), tunnel: undefined };
};

const addConnectionToCell = (
  railMap: Map<string, CellData>,
  key: string,
  dir: number,
  flags: Pick<CellData, 'bridge' | 'tunnel'>
): void => {
  const existing = railMap.get(key);
  if (!existing) {
    railMap.set(key, { type: 'rail', connections: dir, ...flags });
  } else if (existing.type !== 'rail') {
    railMap.set(key, { ...existing, connections: (existing.connections || 0) | dir });
  } else {
    railMap.set(key, { ...existing, connections: (existing.connections || 0) | dir, ...flags });
  }
};

export interface RailPathApplyResult extends ConstructionState {
  /**
   * このpath適用によって立体交差(upper)になった/拡張されたセルのキー集合。
   * 自動高架は廃止したため、線路敷設(applyRailPath)では常に空集合になる。
   * 橋(applyBridge)では別途橋桁セルの集合をoverpassCells相当として扱う
   * (evaluateBuild側でbridge専用に計算する)。
   */
  overpassCells: Set<string>;
}

// applyRailPathの詳細版。overpassCellsは自動高架の廃止により常に空集合。
// 呼び出し側(economy.costOfPath等)との互換のため型は維持している。
//
// 経路の端が既存の高架(別レベルM>0の線路)の端タイルに接する場合だけ、
// applyGroundPathWithElevatedConnectへ委譲して自動で坂を作り接続する
// (詳細はそちらのdocコメント参照)。それ以外(従来通りの平坦な地平線路)は
// 下の単純なループのまま、挙動を一切変えない。
export function applyRailPathDetailed(
  state: ConstructionState,
  path: Pos[],
  field: TerrainField = EMPTY_FIELD,
  // 町タイル索引(sim/townTiles.tsのbuildTownTileIndex)。省略時は町タイル無し扱い。
  // 家タイルを通る経路はno-op(道路タイルは踏切として通過できる)。
  townTiles: TownTileIndex = EMPTY_TOWN_TILES
): RailPathApplyResult {
  // 家タイルの上には地平の線路を敷けない(高架のみ通過可)。経路のどこか1セルでも
  // 家に抵触すれば建設全体をno-opにする(部分建設で町を壊さないため)。
  if (pathCrossesHouseTile(townTiles, path)) return { ...state, overpassCells: new Set() };

  if (path.length >= 2) {
    const startEnd = pickElevatedConnection(resolveElevatedPathEnd(state.railMap, path[0]), 0);
    const endEnd = pickElevatedConnection(resolveElevatedPathEnd(state.railMap, path[path.length - 1]), 0);
    if (startEnd.kind === 'connect' || endEnd.kind === 'connect') {
      const plan = planElevatedPath(path.length, startEnd, endEnd, 0);
      if (plan) {
        const result = applyGroundPathWithElevatedConnect(state, path, field, plan);
        if (result) return result;
      }
      // planがnull、または坂条件(車庫・地形)を満たせない場合は、接続を諦めて
      // 通常の平坦な地平線路として下のループにフォールバックする。
    }
  }

  // 既存の坂セルへ、その軸と異なる方向の接続を追加してしまう経路はno-opにする
  // (坂セルを壊さないため。詳細はconflictsWithExistingRampのdocコメント参照)。
  if (pathConflictsWithExistingRamp(state.railMap, path)) return { ...state, overpassCells: new Set() };

  // P7b: 勾配追従(flat/incline)で建設できないセルを、必要なら定高さのtunnelとして
  // 建設する計画を立てる。runの高さがterrain以下だったり坑口の標高が繋がらない場合は
  // nullになり、経路全体をno-opにする(部分建設で破綻した見た目を残さないため)。
  const plan = resolveGroundRailPlan(field, path);
  if (!plan) {
    return { ...state, overpassCells: new Set() };
  }

  const railMap = new Map(state.railMap);
  const overpassCells = new Set<string>();

  for (let i = 0; i < path.length - 1; i++) {
    const curr = path[i];
    const next = path[i + 1];
    const currKey = toKey(curr.x, curr.z);
    const nextKey = toKey(next.x, next.z);
    const dx = next.x - curr.x;
    const dz = next.z - curr.z;
    const dir = getDirFromVector(dx, dz);
    const oppDir = getOppositeDir(dir);

    addConnectionToCell(railMap, currKey, dir, cellFlagsForRole(field, plan[i], curr.x, curr.z));
    if (railMap.get(currKey)?.type === 'depot') updateDepotRotation(railMap, curr.x, curr.z);

    addConnectionToCell(railMap, nextKey, oppDir, cellFlagsForRole(field, plan[i + 1], next.x, next.z));
    if (railMap.get(nextKey)?.type === 'depot') updateDepotRotation(railMap, next.x, next.z);

    const checkDepotNeighbours = (px: number, pz: number) => {
      const nbs = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
      nbs.forEach(n => updateDepotRotation(railMap, px + n.x, pz + n.z));
    };
    checkDepotNeighbours(curr.x, curr.z);
    checkDepotNeighbours(next.x, next.z);
  }

  return { railMap, stations: state.stations, overpassCells };
}

export function applyRailPath(
  state: ConstructionState,
  path: Pos[],
  field: TerrainField = EMPTY_FIELD,
  townTiles: TownTileIndex = EMPTY_TOWN_TILES
): ConstructionState {
  return applyRailPathDetailed(state, path, field, townTiles);
}

/**
 * 地平(レベル0)の線路建設で、経路の端が「浮いた高架(既存の別レベルM>0の線路)」の
 * 端タイルに接した場合だけ使う内部ヘルパー。planElevatedPath(level=0)が返す計画に
 * 従い、坂になるセルだけ地平から高架レベルMまで自動で登る坂にし、残りは通常の
 * 地平の線路として敷く。applyRailPathDetailedから、接続の見込みがある場合だけ呼ばれる
 * (それ以外は従来のシンプルな実装のまま)。
 *
 * 坂条件(車庫・地形)を満たさない場合はnullを返し、呼び出し元は従来の
 * 平坦な地平線路としてフォールバックする。
 */
/**
 * 坂になるセル(plan.roles[i].kind==='ramp')がすべて建設可能かどうかを判定する。
 * 車庫セル・水域山岳セルには坂を作れない。坂の区間は直線(進入方向と退出方向が
 * 正反対)でなければならない — buildRampTrackParts(render/trackGeometry.ts)は
 * ramp.dir 1方向ぶんの傾斜ジオメトリしか生成できず、坂セルでカーブ(進入/退出
 * 方向が直線でない)すると、もう一方の方向ビットが平坦(高さ0)な部品として
 * 誤って描かれ、宙に浮いた破片や向きの狂ったスラブになる不具合があったため
 * (Cities: Skylinesなど他の鉄道シムでも坂は直線区間のみという割り切りが一般的)。
 * applyGroundPathWithElevatedConnect/applyElevatedPath(実際の建設)と
 * buildPreview.ts(コスト・可否のプレビュー)の両方から使う共通ルールなので、
 * ここに一本化しておく(UI側にルールを書き写さないため)。
 */
export function isElevatedConnectPlanBuildable(
  railMap: Map<string, CellData>,
  path: Pos[],
  field: TerrainField,
  plan: ElevatedPathPlan
): boolean {
  for (let i = 0; i < path.length; i++) {
    if (plan.roles[i].kind !== 'ramp') continue;
    if (railMap.get(toKey(path[i].x, path[i].z))?.type === 'depot') return false;
    if (!isFlatGroundLevelZero(field, path[i].x, path[i].z)) return false;
  }
  if (pathConflictsWithExistingRamp(railMap, path)) return false;
  return planHasStraightRamps(path, plan);
}

/**
 * 坂(ramp)になる各セルで、経路の進入方向と退出方向が正反対(=直線)であることを
 * 確認する。坂の途中でカーブしていたらfalseを返す。isElevatedConnectPlanBuildableの
 * 一部として使うほか、applyElevatedPath側の同種チェックにも使う。
 */
export function planHasStraightRamps(path: Pos[], plan: ElevatedPathPlan): boolean {
  for (let i = 0; i < path.length; i++) {
    if (plan.roles[i].kind !== 'ramp') continue;
    const prevDir = i > 0 ? getDirFromVector(path[i - 1].x - path[i].x, path[i - 1].z - path[i].z) : 0;
    const nextDir = i < path.length - 1 ? getDirFromVector(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z) : 0;
    if (prevDir !== 0 && nextDir !== 0 && getOppositeDir(prevDir) !== nextDir) return false;
  }
  return true;
}

// role.sideだけでは「登る方向(高い側=既存構造へ向かう向き)」を一意に決められない。
// 通常(高架建設が下位へ降りるascendingの坂、桁が経路内部の別セルとして一緒に
// 建設される)は、そのside(start/end)にとって「経路の内側(桁)へ向かう向き」が
// 登る方向になる。一方、地平からの自動接続(descending、既存構造がまさにその
// 境界セル=アンカー自身)では逆に「経路の外側(アンカー)へ向かう向き」が登る方向になる。
// plan.rolesの境界セルがanchorかどうかを見て、side→(prevDir|nextDir)のどちらを
// 採用するかを一箇所で決める(applyGroundPathWithElevatedConnect/applyElevatedPathの
// 両方から使う)。
function rampDirResolver(
  plan: ElevatedPathPlan,
  length: number
): (side: 'start' | 'end', prevDir: number, nextDir: number) => number {
  const anchorAtStart = plan.roles[0]?.kind === 'anchor';
  const anchorAtEnd = plan.roles[length - 1]?.kind === 'anchor';
  return (side, prevDir, nextDir) => {
    if (side === 'start') return anchorAtStart ? prevDir : nextDir;
    return anchorAtEnd ? nextDir : prevDir;
  };
}

function applyGroundPathWithElevatedConnect(
  state: ConstructionState,
  path: Pos[],
  field: TerrainField,
  plan: ElevatedPathPlan
): RailPathApplyResult | null {
  if (!isElevatedConnectPlanBuildable(state.railMap, path, field, plan)) return null;

  const railMap = new Map(state.railMap);
  const dirBetween = (a: number, b: number): number =>
    getDirFromVector(path[b].x - path[a].x, path[b].z - path[a].z);
  const rampDirFor = rampDirResolver(plan, path.length);

  for (let i = 0; i < path.length; i++) {
    const role = plan.roles[i];
    const key = toKey(path[i].x, path[i].z);
    const prevDir = i > 0 ? dirBetween(i, i - 1) : 0;
    const nextDir = i < path.length - 1 ? dirBetween(i, i + 1) : 0;
    const axisBits = prevDir | nextDir;

    if (role.kind === 'span') {
      addConnectionToCell(railMap, key, axisBits, terrainFlags(field, path[i].x, path[i].z));
      if (railMap.get(key)?.type === 'depot') updateDepotRotation(railMap, path[i].x, path[i].z);
      continue;
    }

    if (role.kind === 'anchor') {
      // 既存の高架レベルconnectLevelの端タイルそのもの。既存データ(桁の内部接続等)は
      // 一切書き換えず、uppers[connectLevel].connectionsへ新しい方向ビットをORするだけに
      // 留める(rampは付与しない。桁+坂の二重描画を避けるため)。
      const dir = role.side === 'start' ? nextDir : prevDir;
      const existing = railMap.get(key);
      const upperAtLevel = existing?.uppers?.[role.connectLevel as Level];
      railMap.set(key, {
        ...(existing ?? { type: 'rail' }),
        uppers: {
          ...(existing?.uppers ?? {}),
          [role.connectLevel]: { connections: (upperAtLevel?.connections ?? 0) | dir, stationId: upperAtLevel?.stationId },
        },
      });
      continue;
    }

    const rampDir = rampDirFor(role.side, prevDir, nextDir);
    const existing = railMap.get(key);
    const merged = orIntoBaseLevel(existing, role.base, axisBits);
    railMap.set(key, {
      ...merged,
      type: merged.type ?? 'rail',
      ...terrainFlags(field, path[i].x, path[i].z),
      ramp: { dir: rampDir, level: role.level, base: role.base },
    });
    if (railMap.get(key)?.type === 'depot') updateDepotRotation(railMap, path[i].x, path[i].z);
  }

  return { railMap, stations: state.stations, overpassCells: new Set() };
}

export function applyStation(
  state: ConstructionState,
  pos: Pos,
  field: TerrainField = EMPTY_FIELD,
  towns: TownData[] = [],
  axis?: StationAxis,
  townTiles: TownTileIndex = EMPTY_TOWN_TILES
): ConstructionState {
  const key = toKey(pos.x, pos.z);
  const existingBeforeUpdate = state.railMap.get(key);

  // 駅は平地にしか置けない: 水域・山岳セルへの設置は no-op(課金もされない)
  if (!isBuildableGround(field, pos.x, pos.z)) {
    return state;
  }

  // 町タイル(家・道路のどちらも)への設置は no-op。家は当然として、道路タイルに
  // 駅を建てると町の道路網が視覚上寸断されるため許可しない。
  if (townTileAt(townTiles, pos.x, pos.z)) {
    return state;
  }

  // 車庫があるセルへの設置は従来通り no-op(車庫が消えないように)
  if (existingBeforeUpdate && existingBeforeUpdate.type === 'depot') {
    return state;
  }

  // 坂(ramp)セルへの設置も no-op。坂セルは直線の斜面専用
  // (conflictsWithExistingRampのdocコメント参照)で、駅の軸ビットをORすると
  // 「斜面+直交する平坦な接続」という描画できない壊れた状態になるため。
  // 同一参照を返すことで、buildPreview側は「効果なし=建設不可」と判定できる。
  if (existingBeforeUpdate?.ramp) {
    return state;
  }

  const neighbours = [
    { x: pos.x + 1, z: pos.z },
    { x: pos.x - 1, z: pos.z },
    { x: pos.x, z: pos.z + 1 },
    { x: pos.x, z: pos.z - 1 },
  ];

  // 十字駅対応: 駅セルは他の駅セルと交差できる(ダイヤモンドクロッシングの駅版)。
  // pos自身が既に駅セルの場合(横切られる側)と、隣接4セルに駅がある場合の両方から
  // 関係する駅IDを集める。2つ以上の異なる駅IDが関わっていれば、それらは1つの駅に統合する
  // (乗り換え駅なので同一駅として扱うのが自然)。
  const crossingStationId = existingBeforeUpdate?.type === 'station' ? (existingBeforeUpdate.stationId ?? null) : null;

  const involvedIds: string[] = [];
  const pushId = (id: string | null | undefined) => {
    if (id && !involvedIds.includes(id)) involvedIds.push(id);
  };
  pushId(crossingStationId);
  for (const n of neighbours) {
    const cell = state.railMap.get(toKey(n.x, n.z));
    if (cell && cell.type === 'station') pushId(cell.stationId ?? null);
  }

  // 軸(axis)は明示的に渡されればそれを使い、省略時は隣接する既存の線路・駅から推測する
  // (何も無ければ東西を既定にする)。ただし既存の接続を持つセルに対しては、
  // ヒントの軸方向に実在の隣接構造が無い限りヒントを採用しない(axisHintIsSupported)。
  const ownConnections = existingBeforeUpdate && (existingBeforeUpdate.type === 'rail' || existingBeforeUpdate.type === 'station')
    ? (existingBeforeUpdate.connections ?? 0)
    : 0;
  const trustedAxis = axis && axisHintIsSupported(state.railMap, pos.x, pos.z, ownConnections, axis) ? axis : undefined;
  const resolvedAxis: StationAxis = trustedAxis ?? inferStationAxis(state.railMap, pos.x, pos.z);
  const newBits = axisBitsFor(resolvedAxis);

  // 既に駅セルで、統合すべき別の駅IDが周囲に無い場合:
  // 新しい軸ビットが既存のconnectionsに全て含まれていれば真のno-op(バグ1/2対策の再設置防止)。
  // 含まれていないビットがあれば「直交する軸で既存の駅セルを横切った」ケースなので、
  // 駅の統合は不要(同じ駅のまま)だが接続だけを拡張する。
  if (crossingStationId && involvedIds.length <= 1) {
    const existingBits = existingBeforeUpdate!.connections ?? 0;
    if ((existingBits & newBits) === newBits) {
      return state;
    }
    const railMap = new Map(state.railMap);
    railMap.set(key, { ...existingBeforeUpdate!, connections: existingBits | newBits });
    return { railMap, stations: state.stations };
  }

  const railMap = new Map(state.railMap);
  const stations = new Map(state.stations);
  let targetId: string;

  if (involvedIds.length >= 2) {
    // 十字駅: 複数の駅にまたがるセル → 先に存在した(stations Mapで挿入順が最も早い)駅へ統合する
    const order = Array.from(state.stations.keys());
    involvedIds.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const keepId = involvedIds[0];
    const keepSt = stations.get(keepId)!;
    const cellMap = new Map<string, { x: number; z: number }>();
    keepSt.cells.forEach(c => cellMap.set(toKey(c.x, c.z), c));
    for (let i = 1; i < involvedIds.length; i++) {
      const removeId = involvedIds[i];
      const removeSt = stations.get(removeId);
      if (!removeSt) continue;
      removeSt.cells.forEach(c => {
        cellMap.set(toKey(c.x, c.z), c);
        const ck = toKey(c.x, c.z);
        const cell = railMap.get(ck);
        if (cell && cell.type === 'station' && cell.stationId === removeId) {
          railMap.set(ck, { ...cell, stationId: keepId });
        }
      });
      stations.delete(removeId);
    }
    cellMap.set(key, { x: pos.x, z: pos.z });
    const mergedCells = Array.from(cellMap.values());
    const cx = mergedCells.reduce((sum, c) => sum + c.x, 0) / mergedCells.length;
    const cz = mergedCells.reduce((sum, c) => sum + c.z, 0) / mergedCells.length;
    stations.set(keepId, { ...keepSt, cells: mergedCells, center: { x: cx, z: cz } });
    targetId = keepId;
  } else if (involvedIds.length === 1) {
    targetId = involvedIds[0];
    const st = stations.get(targetId)!;
    if (!st.cells.some(c => c.x === pos.x && c.z === pos.z)) {
      const newCells = [...st.cells, { x: pos.x, z: pos.z }];
      const cx = newCells.reduce((sum, c) => sum + c.x, 0) / newCells.length;
      const cz = newCells.reduce((sum, c) => sum + c.z, 0) / newCells.length;
      stations.set(targetId, { ...st, cells: newCells, center: { x: cx, z: cz } });
    }
  } else {
    targetId = Math.random().toString(36).substr(2, 9);
    const newName = stationNameFor(pos, stations, towns);
    stations.set(targetId, { id: targetId, name: newName, cells: [{ x: pos.x, z: pos.z }], center: { x: pos.x, z: pos.z }, platformDoors: 'none' });
  }

  // バグ3対策: 既存の rail/station セルを駅化する場合は connections を維持しつつ、
  // 今回の軸ビットを追加する(斜め線路等の既存接続を消さないため)。
  // 空セルに新規設置する場合は軸ビットだけで初期化する。
  const connections = existingBeforeUpdate && (existingBeforeUpdate.type === 'rail' || existingBeforeUpdate.type === 'station')
    ? (existingBeforeUpdate.connections || 0) | newBits
    : newBits;

  // バグ修正: 既存セルが持つupper(高架線)・ramp(坂)・bridge・tunnelを消さないよう
  // 丸ごと置き換えず、既存フィールドをスプレッドしたうえでtype/connections/stationIdだけ上書きする。
  railMap.set(key, { ...existingBeforeUpdate, type: 'station', connections, stationId: targetId });
  neighbours.forEach(n => updateDepotRotation(railMap, n.x, n.z));

  return { railMap, stations };
}

export function applyDepot(
  state: ConstructionState,
  pos: Pos,
  field: TerrainField = EMPTY_FIELD,
  townTiles: TownTileIndex = EMPTY_TOWN_TILES
): ConstructionState {
  const key = toKey(pos.x, pos.z);
  const existing = state.railMap.get(key);

  // 車庫は平地にしか置けない: 水域・山岳セルへの設置は no-op(課金もされない)
  if (!isBuildableGround(field, pos.x, pos.z)) {
    return state;
  }

  // 町タイル(家・道路)への設置は no-op(applyStationと同じ理由)。
  if (townTileAt(townTiles, pos.x, pos.z)) {
    return state;
  }

  // バグ1対策: 空セル以外への設置は no-op（駅の上に車庫を置いて駅を消してしまわないように）
  if (existing) {
    return state;
  }

  const railMap = new Map(state.railMap);
  railMap.set(key, { type: 'depot', connections: DIR.N | DIR.E | DIR.S | DIR.W, rotation: 0 });
  updateDepotRotation(railMap, pos.x, pos.z);

  return { railMap, stations: state.stations };
}

export function applySignal(
  state: ConstructionState,
  path: Pos[],
  field: TerrainField = EMPTY_FIELD,
  townTiles: TownTileIndex = EMPTY_TOWN_TILES
): ConstructionState {
  const pos = path[0];
  const key = toKey(pos.x, pos.z);
  const cell = state.railMap.get(key);
  if (!cell || (cell.type !== 'rail' && cell.type !== 'station')) return state;
  // 信号は平地にしか置けない: 橋・トンネル区間(水域・山岳)への設置は no-op
  if (!isBuildableGround(field, pos.x, pos.z)) return state;
  // 町タイル(家・道路=踏切)への設置も no-op(踏切セルには信号機を建てない)。
  if (townTileAt(townTiles, pos.x, pos.z)) return state;

  const railMap = new Map(state.railMap);
  const conns = cell.connections || 0;

  if (!cell.signalDir) {
    let firstDir = DIR.N;
    const dirs = [DIR.N, DIR.E, DIR.S, DIR.W, DIR.NE, DIR.SE, DIR.SW, DIR.NW];
    for (const d of dirs) {
      if (conns & d) {
        firstDir = d;
        break;
      }
    }
    railMap.set(key, { ...cell, signalDir: firstDir });
  } else {
    const currentDir = cell.signalDir;
    let nextDir = currentDir;
    const dirs = [DIR.N, DIR.NE, DIR.E, DIR.SE, DIR.S, DIR.SW, DIR.W, DIR.NW];
    const idx = dirs.indexOf(currentDir);
    for (let i = 1; i <= 8; i++) {
      const d = dirs[(idx + i) % 8];
      if (conns & d) {
        nextDir = d;
        break;
      }
    }
    railMap.set(key, { ...cell, signalDir: nextDir });
  }

  return { railMap, stations: state.stations };
}

// --- 自由に敷ける高架線(applyElevatedPath) ---
//
// 旧・applyBridgeは「両端2セルずつが坂+中間が桁」の固定構成で直線8方向のみ・
// 長さ5〜12セル限定という強い制約があった。Simutrans的に自由な高架線を敷けるように
// するため、applyRailPathと同じ経路制約(隣接8方向を辿ればよく、曲がってもよい)で
// 任意長の経路を高架にできる関数を新設する。
//
// 端の扱い: 経路の始点・終点それぞれについて、
// - その位置が「既に高架(upper.connectionsを持つ)」なら、既存の高架へ継ぎ足す形に
//   なるため坂は作らない(高架のまま連続する)。
// - そうでない(地平の線路・駅・空セルいずれか)場合は、行き止まりでも地面へ降りられる
//   よう、その端の2セル(外側=level1、内側=level2)を坂にする。
// 中間セル(坂にならない残り)はすべて橋桁(upper)になる。
//
// この「端が坂になるか高架のまま続くか」の判定は resolveElevatedPathEnd として、
// 各セルへの役割(坂/橋桁)の割り当ては planElevatedPath として、それぞれ独立した
// 純粋関数に切り出してある(テスト容易性のため)。

export type ElevatedLevel = 1 | 2 | 3;
// P8a: 地下レベル(掘割ランプで地表とつながる負のレベル)。高架(ElevatedLevel)と
// 符号対称の構造(uppers/ramp.base/pickElevatedConnection/planElevatedPathの共有ロジック)。
export type UndergroundLevel = -1 | -2 | -3;
// 建設レベル。0は地平(従来のapplyRailPath/applyStationと完全に同一挙動)。
export type BuildLevel = 0 | Level;
// uppersの全レベル(高架+地下)を走査するときに使う。
export const ALL_LEVELS: readonly Level[] = [1, 2, 3, -1, -2, -3];

/**
 * 高架線(applyElevatedPath)・地下線(applyUndergroundPath)を敷くのに最低限必要な
 * 経路の長さ。1マスでは坂/桁の役割分担(planElevatedPath)が成立しないため、
 * どちらも path.length < この値 を no-op にする。
 *
 * buildPreview.tsも同じ定数を参照し、「ドラッグ前のホバー(1マス)」を
 * 「ここには建設できません(=その場所自体が不可)」ではなく
 * 「経路がまだ足りない」として区別するために使う(0.5.0-Alpha-4c)。
 */
export const LAYERED_RAIL_MIN_PATH_CELLS = 2;

/**
 * 経路の端(始点 or 終点)に既に存在する線路のレベル一覧を返す(昇順、0=地平、1〜3=uppers)。
 * 各レベルは独立して併存できるため、複数レベルが同時に存在してもよい。
 */
export function resolveElevatedPathEnd(
  railMap: Map<string, CellData>,
  pos: Pos
): { levels: number[] } {
  const existing = railMap.get(toKey(pos.x, pos.z));
  const levels: number[] = [];
  if (existing?.connections) levels.push(0);
  for (const lvl of ALL_LEVELS) {
    if (existing?.uppers?.[lvl]?.connections) levels.push(lvl);
  }
  return { levels };
}

/**
 * 経路の端(始点 or 終点)が、建設レベルに対してどう振る舞うかを決める。
 * - continue: 同じレベルの既存線路へ坂なしで継ぎ足す
 * - connect: 建設レベルLとは異なる既存レベルMが見つかったので、L↔Mを繋ぐ坂を作る
 *   (Lに最も近いMを選ぶ)。L>=1のときはLより低いMのみを対象にする(高架建設は
 *   下位レベルへ降りる坂のみ)。L===0(地平)のときはLより高いMのみを対象にする
 *   (地平の線路を浮いた高架の端に当てると自動で登る坂ができる)。
 * - flat: 対象方向に何も無ければ、坂を作らず浮いた端のまま終端する
 */
export type ElevatedEndPlan =
  | { kind: 'continue' }
  | { kind: 'connect'; level: number }
  | { kind: 'flat' };

export function pickElevatedConnection(
  info: { levels: number[] },
  level: BuildLevel
): ElevatedEndPlan {
  if (info.levels.includes(level)) return { kind: 'continue' };
  if (level === 0) {
    // 地平(0)建設: 自分より高い既存レベルのうち最も近い(最小の)ものへ坂で登る。
    const upCandidates = info.levels.filter(l => l > 0);
    if (upCandidates.length > 0) return { kind: 'connect', level: Math.min(...upCandidates) };
    // P8a: 上に無ければ、自分より低い(地下)既存レベルのうち最も近い(最大=0に近い)
    // ものへ掘割で降りる(高架側と符号対称)。
    const downCandidates = info.levels.filter(l => l < 0);
    if (downCandidates.length === 0) return { kind: 'flat' };
    return { kind: 'connect', level: Math.max(...downCandidates) };
  }
  if (level > 0) {
    const candidates = info.levels.filter(l => l < level);
    if (candidates.length === 0) return { kind: 'flat' };
    return { kind: 'connect', level: Math.max(...candidates) };
  }
  // P8a: level < 0(地下建設)。地平・高架側は0に近いほうから対称に「自分より高い
  // (=0に近い)既存レベルのうち最も近いもの」へ坂(掘割)で繋ぐ。
  const candidates = info.levels.filter(l => l > level);
  if (candidates.length === 0) return { kind: 'flat' };
  return { kind: 'connect', level: Math.min(...candidates) };
}

export type ElevatedCellRole =
  | { kind: 'span' }
  | { kind: 'ramp'; side: 'start' | 'end'; base: number; level: 1 | 2 }
  // 接続先の既存レベルconnectLevelの端タイルそのもの(アンカー)。このセルは既存の
  // 桁/地平データをそのまま持つ既存セルであり、坂(ramp)を新たに割り当てることはしない
  // (桁セルに「平坦な桁」と「坂の一部」を同居させると、buildRampTrackParts(1方向の
  // 傾斜しか描けない)とTrackNetwork.tsxの平坦描画が二重に走り、宙に浮いた破片や
  // 段差の描画崩壊を起こすため)。connectLevel>level(地平などが上位の既存高架へ登る)
  // の場合だけ現れる。呼び出し側はuppers[connectLevel](またはconnectLevel===0なら
  // connections)へ新しい方向ビットをORするだけに留めること。
  | { kind: 'anchor'; side: 'start' | 'end'; connectLevel: number };

export interface ElevatedPathPlan {
  roles: ElevatedCellRole[];
}

/**
 * 経路の各セルに「坂(どちら側の・どの段の)」か「橋桁/地平」か「アンカー(既存桁そのもの)」か
 * を割り当てる。level は建設するレベル(0=地平〜3)。各端の扱い(startEnd/endEnd)は
 * pickElevatedConnectionが決めた ElevatedEndPlan を渡す。
 * - kind:'connect'(level: M) の端は、min(M,level)〜max(M,level)-1の各段差2セルずつ
 *   (計 2*|level-M| セル)が坂になる。M<level(高架建設が下位へ降りる)の場合、
 *   経路の端タイル自体がその坂の最下段(=M)を兼ねる(既存資源Mへ直接書き込むのと
 *   ちょうど一致するため、旧来通り端タイルもramp扱いでよい)。M>level(地平建設が
 *   上位の既存高架へ登る)の場合は、経路の端タイルは既存の桁セルそのもの(アンカー、
 *   kind:'anchor')として別枠にし、その内側の2*|level-M|セルだけが坂になる
 *   (=坂とアンカーで計 2*|level-M|+1 セルを消費する)。旧来の高架建設の下り坂
 *   (M<level)と完全に対称なデータ形状にするための非対称処理。
 * - kind:'continue'/'flat' の端は坂を作らない(そのまま端に達するか、既存線路へ継ぎ足す)
 * 割り当てが物理的に矛盾する(坂+アンカーに必要なセル数が経路長を超える、あるいは
 * 継ぎ足し先/浮いた端のセルを坂で上書きしてしまう)場合は null を返す。
 */
export function planElevatedPath(
  length: number,
  startEnd: ElevatedEndPlan,
  endEnd: ElevatedEndPlan,
  level: BuildLevel = 1
): ElevatedPathPlan | null {
  if (length < 2) return null;

  // アンカーが要るのはconnectLevel(M) > level のときだけ(地平などが上位の既存高架へ登る場合)。
  // M < level(高架建設が下位へ降りる、従来からの向き)はアンカー無しで従来通り。
  // P8a: アンカーの要否は「M(接続先の既存レベル)がlevelより地表から遠いか」で決める
  // (地表(0)からの距離で符号対称に判定する)。level>=0(高架建設)では従来通り
  // M>levelがアンカー(地平などが上位の既存高架へ登る)。level<0(地下建設)では
  // M<levelがアンカー(高架と符号対称: 地下建設が下位の既存地下へ潜る)。
  // なお base の割り当て(assignRampZone内のascending)はM/levelの生の大小関係を
  // そのまま使えば符号に関わらず正しい(そちらは変更不要)。
  const sideInfo = (end: ElevatedEndPlan): { rampCount: number; anchor: boolean } => {
    if (end.kind !== 'connect') return { rampCount: 0, anchor: false };
    // level===0(地平)は、connectできるMが必ず0以外(=必ず地表から見て遠い)なので常にアンカー。
    const isAnchor = level === 0 ? true : (level > 0 ? end.level > level : end.level < level);
    return { rampCount: 2 * Math.abs(level - end.level), anchor: isAnchor };
  };
  const startInfo = sideInfo(startEnd);
  const endInfo = sideInfo(endEnd);
  const startTotal = startInfo.rampCount + (startInfo.anchor ? 1 : 0);
  const endTotal = endInfo.rampCount + (endInfo.anchor ? 1 : 0);
  if (startTotal > length || endTotal > length) return null;

  // zoneIndicesは常に「接続先に近い側→経路内側」の順。アンカーがある側は、境界
  // セル(0 または length-1)をアンカー専用に確保し、坂の割り当てはその1つ内側から始める。
  const rampZoneStart = startInfo.rampCount > 0
    ? Array.from({ length: startInfo.rampCount }, (_, i) => i + (startInfo.anchor ? 1 : 0))
    : [];
  const rampZoneEnd = endInfo.rampCount > 0
    ? Array.from({ length: endInfo.rampCount }, (_, i) => length - 1 - (endInfo.anchor ? 1 : 0) - i)
    : [];
  const anchorStartIdx = startInfo.anchor ? 0 : null;
  const anchorEndIdx = endInfo.anchor ? length - 1 : null;

  // 坂を作らない端(continue/flat)のセルは絶対に他方の坂で上書きしてはいけない保護インデックス。
  const protectedIndices = new Set<number>([
    ...(startEnd.kind !== 'connect' ? [0] : []),
    ...(endEnd.kind !== 'connect' ? [length - 1] : []),
  ]);

  const usedIndices = new Set<number>([
    ...rampZoneStart,
    ...rampZoneEnd,
    ...(anchorStartIdx !== null ? [anchorStartIdx] : []),
    ...(anchorEndIdx !== null ? [anchorEndIdx] : []),
  ]);
  const expectedUsedCount =
    rampZoneStart.length + rampZoneEnd.length + (anchorStartIdx !== null ? 1 : 0) + (anchorEndIdx !== null ? 1 : 0);
  if (usedIndices.size < expectedUsedCount) return null; // 坂/アンカー同士が重なる
  for (const idx of usedIndices) {
    if (protectedIndices.has(idx)) return null; // 坂が継ぎ足し先/浮いた端を潰してしまう
  }

  const roles: ElevatedCellRole[] = new Array(length).fill(null).map(() => ({ kind: 'span' as const }));

  // 接続先レベルMと建設レベルlevelの間を、1段差ごとに2セル(下段level1→上段level2)で
  // 埋める。M<level(上に接続先→内側へ登る、高架建設が地平/低層へ降りる場合)なら
  // baseをMから昇順に積み上げ、M>level(接続先→内側へ降りる、地平建設が高架へ登る場合)
  // ならbaseをM-1から降順に積み下げる。zoneIndicesは常に「接続先に近い側→経路内側」の順。
  const assignRampZone = (zoneIndices: number[], side: 'start' | 'end', connectLevel: number) => {
    const steps = zoneIndices.length / 2;
    const ascending = connectLevel < level;
    for (let step = 0; step < steps; step++) {
      const base = ascending ? connectLevel + step : connectLevel - 1 - step;
      // 接続先に近い側のセルは、ascendingなら低段(level1)、そうでなければ高段(level2)。
      const nearIdx = zoneIndices[step * 2];
      const farIdx = zoneIndices[step * 2 + 1];
      if (ascending) {
        roles[nearIdx] = { kind: 'ramp', side, base, level: 1 };
        roles[farIdx] = { kind: 'ramp', side, base, level: 2 };
      } else {
        roles[nearIdx] = { kind: 'ramp', side, base, level: 2 };
        roles[farIdx] = { kind: 'ramp', side, base, level: 1 };
      }
    }
  };
  if (startEnd.kind === 'connect') assignRampZone(rampZoneStart, 'start', startEnd.level);
  if (endEnd.kind === 'connect') assignRampZone(rampZoneEnd, 'end', endEnd.level);
  if (anchorStartIdx !== null && startEnd.kind === 'connect') {
    roles[anchorStartIdx] = { kind: 'anchor', side: 'start', connectLevel: startEnd.level };
  }
  if (anchorEndIdx !== null && endEnd.kind === 'connect') {
    roles[anchorEndIdx] = { kind: 'anchor', side: 'end', connectLevel: endEnd.level };
  }

  return { roles };
}

/**
 * 自由な経路に高架線を敷く。path は applyRailPath と同じく隣接8方向を辿る経路であれば
 * よく、曲がってもよい。長さの上下限は無い。
 *
 * 建設不可条件(いずれか1つでも該当すれば no-op で state をそのまま返す):
 * - path が隣接していない(8方向で繋がらない箇所がある)
 * - 坂・橋桁の役割分担が矛盾する(planElevatedPathがnullを返す。例: 経路が短すぎる)
 * - 車庫セルを経路が通る
 * - 坂になるセルが水域・山岳(建設可能な地面の上にしか置けない)
 * - 橋桁になるセルに、この経路の継ぎ足し元でない既存の同レベルuppersがある(二重架け禁止。
 *   別レベルの桁とは併存できる)
 * - 継ぎ足し先の既存高架レベルが建設レベル(level)と一致しない
 */
export function applyElevatedPath(
  state: ConstructionState,
  path: Pos[],
  field: TerrainField = EMPTY_FIELD,
  level: ElevatedLevel = 1,
  // 旧・applyBridge専用: 端の接続判定を実際の周辺セルから求めず強制する(後方互換用)。
  forcedEnds?: { start?: ElevatedEndPlan; end?: ElevatedEndPlan },
  // 町タイル索引。高架の桁(span)は家タイルの上を通過できるが、地面に接する
  // 坂(ramp)セルは家タイルに置けない。
  townTiles: TownTileIndex = EMPTY_TOWN_TILES
): ConstructionState {
  if (path.length < LAYERED_RAIL_MIN_PATH_CELLS) return state;
  for (let i = 0; i < path.length - 1; i++) {
    const dx = path[i + 1].x - path[i].x;
    const dz = path[i + 1].z - path[i].z;
    if (getDirFromVector(dx, dz) === 0) return state;
  }

  const startEnd = forcedEnds?.start ?? pickElevatedConnection(resolveElevatedPathEnd(state.railMap, path[0]), level);
  const endEnd = forcedEnds?.end ?? pickElevatedConnection(resolveElevatedPathEnd(state.railMap, path[path.length - 1]), level);
  const plan = planElevatedPath(path.length, startEnd, endEnd, level);
  if (!plan) return state;

  // 坂は直線区間のみ(理由はisElevatedConnectPlanBuildableのdocコメント参照)。
  if (!planHasStraightRamps(path, plan)) return state;

  // 既存の坂セルへ、その軸と異なる方向の接続を追加してしまう経路はno-opにする。
  if (pathConflictsWithExistingRamp(state.railMap, path)) return state;

  // 車庫セルは高架にできない(坂・橋桁いずれも)
  for (const cell of path) {
    if (state.railMap.get(toKey(cell.x, cell.z))?.type === 'depot') return state;
  }

  // 坂になるセルは建設可能な地面の上にしか置けない(家タイルの上にも置けない。
  // 桁(span)は家の上空を通過できるが、坂は地面に接するため)。
  for (let i = 0; i < path.length; i++) {
    if (plan.roles[i].kind !== 'ramp') continue;
    if (!isFlatGroundLevelZero(field, path[i].x, path[i].z)) return state;
    if (isTownBlocked(townTiles, path[i].x, path[i].z)) return state;
  }

  // 橋桁セルに既に同レベルのuppersがある場合は二重架け禁止(ただし継ぎ足し元の端は許容)。
  // 別レベルの桁とは併存できるため、そちらは見ない。
  for (let i = 0; i < path.length; i++) {
    if (plan.roles[i].kind !== 'span') continue;
    const isContinuationAnchor =
      (i === 0 && startEnd.kind === 'continue') || (i === path.length - 1 && endEnd.kind === 'continue');
    if (isContinuationAnchor) continue;
    if (state.railMap.get(toKey(path[i].x, path[i].z))?.uppers?.[level]) return state;
  }

  const railMap = new Map(state.railMap);
  const dirBetween = (a: number, b: number): number =>
    getDirFromVector(path[b].x - path[a].x, path[b].z - path[a].z);
  const rampDirFor = rampDirResolver(plan, path.length);

  for (let i = 0; i < path.length; i++) {
    const role = plan.roles[i];
    const key = toKey(path[i].x, path[i].z);
    const prevDir = i > 0 ? dirBetween(i, i - 1) : 0;
    const nextDir = i < path.length - 1 ? dirBetween(i, i + 1) : 0;

    if (role.kind === 'span') {
      const axisBits = prevDir | nextDir;
      const existing = railMap.get(key);
      // levelが地平(level===1が地平に接する最下段の桁)の場合のみ、下の平面交差ビットを
      // 剥がして純粋な立体交差にする(従来挙動)。level>1では下位レベルの線路は
      // 独立して残す(異なるレベルの桁は互いに干渉しない)。
      const base = level === 1
        ? { ...(existing ?? { type: 'rail' as const }), connections: (existing?.connections ?? 0) & ~axisBits }
        : existing;
      const upperAtLevel = base?.uppers?.[level];
      railMap.set(key, {
        ...(base ?? { type: 'rail' }),
        uppers: {
          ...(base?.uppers ?? {}),
          [level]: { connections: (upperAtLevel?.connections ?? 0) | axisBits, stationId: upperAtLevel?.stationId },
        },
      });
    } else if (role.kind === 'anchor') {
      // applyElevatedPath(level>=1)はpickElevatedConnectionの仕様上、常にconnectLevel<level
      // (下位へ降りる)の向きしか作らないため実際には到達しないが、型と将来の拡張のために
      // applyGroundPathWithElevatedConnectと同じ「既存データはORのみ」の扱いを用意しておく。
      const dir = role.side === 'start' ? nextDir : prevDir;
      const existing = railMap.get(key);
      const upperAtLevel = existing?.uppers?.[role.connectLevel as Level];
      railMap.set(key, {
        ...(existing ?? { type: 'rail' }),
        uppers: {
          ...(existing?.uppers ?? {}),
          [role.connectLevel]: { connections: (upperAtLevel?.connections ?? 0) | dir, stationId: upperAtLevel?.stationId },
        },
      });
    } else {
      const bits = prevDir | nextDir;
      const existing = railMap.get(key);
      const merged = orIntoBaseLevel(existing, role.base, bits);
      const rampDir = rampDirFor(role.side, prevDir, nextDir);
      railMap.set(key, {
        ...merged,
        type: merged.type ?? 'rail',
        ...terrainFlags(field, path[i].x, path[i].z),
        ramp: { dir: rampDir, level: role.level, base: role.base },
      });
      if (railMap.get(key)?.type === 'depot') updateDepotRotation(railMap, path[i].x, path[i].z);
    }
  }

  return { railMap, stations: state.stations };
}

/**
 * P8a: 自由に敷ける地下線。applyElevatedPathと同じ経路制約・同じ坂/橋桁(この場合は
 * 「地下線」)の役割分担(resolveElevatedPathEnd/pickElevatedConnection/planElevatedPath
 * を共有)だが、以下の点でapplyElevatedPathと異なる(design doc 4.):
 * - 町タイルはブロックしない(地下は町の下を素通りできるのがそもそもの意義)
 * - 水面下は禁止(pathのどのセルであっても、そこが水域なら建設不可)
 * - underground-design.md「相対深さ方式」により、地下は地表がflat(4隅同値、
 *   任意標高)なセルの下にしか通せない(incline/otherの下は禁止)。これは坂だけでなく
 *   地下線そのもの(span)にも掛かる制約で、applyElevatedPathの「坂だけ地平0限定」とは
 *   異なる
 * - 地下線どうしの隣接(span-span)は undergroundEdgeContinuous で地表標高の連続性を
 *   確認する(地表標高が異なるflatセル同士は繋がらない)
 * - 既存の地平/高架構造とは常に共存する(地平の平面交差ビットを剥がすapplyElevatedPathの
 *   level===1特例に相当する処理を行わない。overpassと同様、地下線は地平線路の下を
 *   ただ通過するだけ)
 */
export function applyUndergroundPath(
  state: ConstructionState,
  path: Pos[],
  field: TerrainField = EMPTY_FIELD,
  level: UndergroundLevel = -1,
  forcedEnds?: { start?: ElevatedEndPlan; end?: ElevatedEndPlan }
): ConstructionState {
  if (path.length < LAYERED_RAIL_MIN_PATH_CELLS) return state;
  for (let i = 0; i < path.length - 1; i++) {
    const dx = path[i + 1].x - path[i].x;
    const dz = path[i + 1].z - path[i].z;
    if (getDirFromVector(dx, dz) === 0) return state;
  }

  const startEnd = forcedEnds?.start ?? pickElevatedConnection(resolveElevatedPathEnd(state.railMap, path[0]), level);
  const endEnd = forcedEnds?.end ?? pickElevatedConnection(resolveElevatedPathEnd(state.railMap, path[path.length - 1]), level);
  const plan = planElevatedPath(path.length, startEnd, endEnd, level);
  if (!plan) return state;

  if (!planHasStraightRamps(path, plan)) return state;
  if (pathConflictsWithExistingRamp(state.railMap, path)) return state;

  for (const cell of path) {
    if (state.railMap.get(toKey(cell.x, cell.z))?.type === 'depot') return state;
  }

  // 地下は(坂・地下線を問わず)水面下禁止・地表がflatなセルの下にしか通せない。
  for (const p of path) {
    if (field.terrainTypeAt(p.x, p.z) === 'water') return state;
    if (!canPlaceFlatStructure(slopeOf(field.cellCornerHeights(p.x, p.z)))) return state;
  }

  // 地下線どうし(span-span)の隣接は地表標高の連続性が必要。
  for (let i = 0; i < path.length - 1; i++) {
    if (plan.roles[i].kind !== 'span' || plan.roles[i + 1].kind !== 'span') continue;
    const dir = getDirFromVector(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
    const cornersA = field.cellCornerHeights(path[i].x, path[i].z);
    const cornersB = field.cellCornerHeights(path[i + 1].x, path[i + 1].z);
    if (!undergroundEdgeContinuous(cornersA, cornersB, dir)) return state;
  }

  // 同レベルの地下線の二重架け禁止(継ぎ足し元の端は許容)。applyElevatedPathと同型。
  for (let i = 0; i < path.length; i++) {
    if (plan.roles[i].kind !== 'span') continue;
    const isContinuationAnchor =
      (i === 0 && startEnd.kind === 'continue') || (i === path.length - 1 && endEnd.kind === 'continue');
    if (isContinuationAnchor) continue;
    if (state.railMap.get(toKey(path[i].x, path[i].z))?.uppers?.[level]) return state;
  }

  const railMap = new Map(state.railMap);
  const dirBetween = (a: number, b: number): number =>
    getDirFromVector(path[b].x - path[a].x, path[b].z - path[a].z);
  const rampDirFor = rampDirResolver(plan, path.length);

  for (let i = 0; i < path.length; i++) {
    const role = plan.roles[i];
    const key = toKey(path[i].x, path[i].z);
    const prevDir = i > 0 ? dirBetween(i, i - 1) : 0;
    const nextDir = i < path.length - 1 ? dirBetween(i, i + 1) : 0;

    if (role.kind === 'span') {
      const axisBits = prevDir | nextDir;
      // 地平・既存高架の接続ビットは一切いじらない(常に共存)。
      const existing = railMap.get(key);
      const upperAtLevel = existing?.uppers?.[level];
      railMap.set(key, {
        ...(existing ?? { type: 'rail' }),
        uppers: {
          ...(existing?.uppers ?? {}),
          [level]: { connections: (upperAtLevel?.connections ?? 0) | axisBits, stationId: upperAtLevel?.stationId },
        },
      });
    } else if (role.kind === 'anchor') {
      const dir = role.side === 'start' ? nextDir : prevDir;
      const existing = railMap.get(key);
      const upperAtLevel = existing?.uppers?.[role.connectLevel as Level];
      railMap.set(key, {
        ...(existing ?? { type: 'rail' }),
        uppers: {
          ...(existing?.uppers ?? {}),
          [role.connectLevel]: { connections: (upperAtLevel?.connections ?? 0) | dir, stationId: upperAtLevel?.stationId },
        },
      });
    } else {
      const bits = prevDir | nextDir;
      const existing = railMap.get(key);
      let merged = orIntoBaseLevel(existing, role.base, bits);
      // P8a: base===-1(地平0への掘割ランプの最初の1段)は、地平から見て「今いる層」が
      // 常に0のまま経路探索されるため(resolveEntryLayerは移動元の層のconnections/uppers
      // しか見ない)、pathfindingが地平側からこのセルへ入ってすぐ先(地下方向)へ進める
      // よう、connections側にも同じビットを重ねて持たせる必要がある(base===0の場合に
      // orIntoBaseLevelがconnectionsへ書くのと対称の理由。base+1===0(地平)の側は
      // このセル自身がuppers[-1]だけを持っていても、地平の層から一切辿り着けない)。
      // ramp.base自体(レンダリング・層遷移のadjacency判定に使う)は-1のまま変えない。
      if (role.base === -1) {
        merged = { ...merged, connections: (merged.connections ?? 0) | bits };
      }
      const rampDir = rampDirFor(role.side, prevDir, nextDir);
      railMap.set(key, {
        ...merged,
        type: merged.type ?? 'rail',
        ramp: { dir: rampDir, level: role.level, base: role.base },
      });
      if (railMap.get(key)?.type === 'depot') updateDepotRotation(railMap, path[i].x, path[i].z);
    }
  }

  return { railMap, stations: state.stations };
}

// 旧・固定長の橋(2セルずつの坂+中間が桁、直線のみ)。自由な高架線(applyElevatedPath)へ
// 置き換えられたが、既存の呼び出し元(pathfinding/reservation/simulationのテスト等)との
// 後方互換のため薄いラッパーとして残す。新仕様の「浮いた端(flat)」は適用せず、
// 両端を強制的に地平(level 0)へ接続させることで、従来通り両端2セルずつが坂になる
// 固定構成を維持する。
export function applyBridge(
  state: ConstructionState,
  path: Pos[],
  field: TerrainField = EMPTY_FIELD
): ConstructionState {
  return applyElevatedPath(state, path, field, 1, {
    start: { kind: 'connect', level: 0 },
    end: { kind: 'connect', level: 0 },
  });
}

/**
 * 高架セル1枚に駅タイルを置く。applyStationと対になる関数で、地平の駅設置と同じ
 * 考え方(隣接する既存の駅への統合)を高架層(uppers)向けに再利用する。
 *
 * - 対象セルの指定レベル(level)にuppers[level].connectionsが無ければ no-op
 *   (先にapplyElevatedPathでそのレベルの高架線を敷いてからでないと駅は置けない)。
 * - 既にそのレベルの高架駅(uppers[level].stationId)なら no-op。
 * - 同じ(x,z)に地平駅セル(type==='station')があれば、その駅IDへ統合する
 *   (立体交差の十字乗換駅は、地平と高架をそれぞれ別々に敷いてから、この関数で
 *   重ねて置くことで手作業で作れる)。
 * - 隣接する同レベルの高架駅セルがあれば、その駅IDへ統合する(高架ホームの延伸)。
 */
// P8a: applyElevatedStation/applyUndergroundStationの共通実装。levelの符号だけが
// 違い(高架は正、地下は負)、駅セルのマージ・命名ロジックは完全に同一のため
// ここへ一本化した(コピーしない)。
function applyLayeredStation(
  state: ConstructionState,
  pos: Pos,
  towns: TownData[],
  level: Level
): ConstructionState {
  const key = toKey(pos.x, pos.z);
  const existing = state.railMap.get(key);
  const upperAtLevel = existing?.uppers?.[level];
  if (!upperAtLevel?.connections) return state; // 高架の線路が無ければ駅は置けない
  if (upperAtLevel.stationId) return state; // 既に高架駅

  const neighbours = [
    { x: pos.x + 1, z: pos.z },
    { x: pos.x - 1, z: pos.z },
    { x: pos.x, z: pos.z + 1 },
    { x: pos.x, z: pos.z - 1 },
  ];

  const involvedIds: string[] = [];
  const pushId = (id?: string | null) => {
    if (id && !involvedIds.includes(id)) involvedIds.push(id);
  };
  // 同じ(x,z)の地平駅があれば統合対象にする(立体交差の十字乗換駅)
  if (existing?.type === 'station' && existing.stationId) pushId(existing.stationId);
  for (const n of neighbours) {
    const cell = state.railMap.get(toKey(n.x, n.z));
    if (cell?.uppers?.[level]?.stationId) pushId(cell.uppers[level]!.stationId);
  }

  const railMap = new Map(state.railMap);
  const stations = new Map(state.stations);
  let targetId: string;

  if (involvedIds.length >= 1) {
    // 先に存在した(stations Mapで挿入順が最も早い)駅へ統合する
    const order = Array.from(state.stations.keys());
    involvedIds.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    targetId = involvedIds[0];
    const keepSt = stations.get(targetId)!;
    const cellMap = new Map<string, { x: number; z: number; layer?: 0 | Level }>();
    keepSt.cells.forEach(c => cellMap.set(`${toKey(c.x, c.z)}|${c.layer ?? 0}`, c));
    for (let i = 1; i < involvedIds.length; i++) {
      const removeId = involvedIds[i];
      const removeSt = stations.get(removeId);
      if (!removeSt) continue;
      removeSt.cells.forEach(c => {
        cellMap.set(`${toKey(c.x, c.z)}|${c.layer ?? 0}`, c);
        const ck = toKey(c.x, c.z);
        const cell = railMap.get(ck);
        if (cell?.uppers?.[level]?.stationId === removeId) {
          railMap.set(ck, {
            ...cell,
            uppers: { ...cell.uppers, [level]: { ...cell.uppers![level]!, stationId: targetId } },
          });
        }
        if (cell?.type === 'station' && cell.stationId === removeId) {
          railMap.set(ck, { ...cell, stationId: targetId });
        }
      });
      stations.delete(removeId);
    }
    cellMap.set(`${key}|${level}`, { x: pos.x, z: pos.z, layer: level });
    const mergedCells = Array.from(cellMap.values());
    const cx = mergedCells.reduce((sum, c) => sum + c.x, 0) / mergedCells.length;
    const cz = mergedCells.reduce((sum, c) => sum + c.z, 0) / mergedCells.length;
    stations.set(targetId, { ...keepSt, cells: mergedCells, center: { x: cx, z: cz } });
  } else {
    targetId = Math.random().toString(36).substr(2, 9);
    const newName = stationNameFor(pos, stations, towns);
    stations.set(targetId, {
      id: targetId,
      name: newName,
      cells: [{ x: pos.x, z: pos.z, layer: level }],
      center: { x: pos.x, z: pos.z },
      platformDoors: 'none',
    });
  }

  railMap.set(key, {
    ...existing!,
    uppers: { ...existing!.uppers, [level]: { ...upperAtLevel, stationId: targetId } },
  });
  return { railMap, stations };
}

export function applyElevatedStation(
  state: ConstructionState,
  pos: Pos,
  towns: TownData[] = [],
  level: ElevatedLevel = 1
): ConstructionState {
  return applyLayeredStation(state, pos, towns, level);
}

/**
 * P8a: 地下駅。applyElevatedStationと符号対称(levelは-1..-3)。地下線は町タイル・
 * 水面下禁止(construction時点でapplyUndergroundPathがブロック済み)の制約を
 * 引き継ぐだけで、駅セル自体のマージ・命名ロジックはapplyElevatedStationと同一。
 */
export function applyUndergroundStation(
  state: ConstructionState,
  pos: Pos,
  towns: TownData[] = [],
  level: UndergroundLevel = -1
): ConstructionState {
  return applyLayeredStation(state, pos, towns, level);
}

// 高架駅のホームセル(x,z,指定レベル)をstations Mapから取り除く。
// 撤去後にセルが0になった駅は消す。地平ホーム(layer 0)は別途、既存の
// cell.type==='station'経路(removePath内)で扱うため、ここでは触らない。
const removeElevatedStationCell = (
  stations: Map<string, StationData>,
  sid: string,
  x: number,
  z: number,
  level: Level
): void => {
  const st = stations.get(sid);
  if (!st) return;
  const newCells = st.cells.filter(c => !(c.x === x && c.z === z && c.layer === level));
  if (newCells.length === st.cells.length) return; // 対象セルが無かった
  if (newCells.length === 0) {
    stations.delete(sid);
    return;
  }
  const cx = newCells.reduce((sum, c) => sum + c.x, 0) / newCells.length;
  const cz = newCells.reduce((sum, c) => sum + c.z, 0) / newCells.length;
  stations.set(sid, { ...st, cells: newCells, center: { x: cx, z: cz } });
};

const RAMP_NEIGHBOUR_OFFSETS = [
  { x: 0, z: -1 }, { x: 1, z: -1 }, { x: 1, z: 0 }, { x: 1, z: 1 },
  { x: 0, z: 1 }, { x: -1, z: 1 }, { x: -1, z: 0 }, { x: -1, z: -1 },
];

/**
 * セルが実体のある高架(いずれかのレベルにconnections>0のuppers)を持つかどうか。
 * uppersオブジェクトは、撤去処理がキーを空にしただけの `{}` や、値がundefinedの
 * キーだけの `{1: undefined}` になりうる(truthyな空オブジェクト)。この状態を
 * `if (cell.uppers)` で判定すると高架撤去の分岐へ誤って入り、地平セルの削除や
 * 隣接の掃除がスキップされるため、判定は必ずこのヘルパーを通すこと。
 */
export const hasAnyUpper = (cell: CellData | undefined): boolean =>
  !!cell?.uppers && ALL_LEVELS.some(lvl => !!cell.uppers?.[lvl]?.connections);

// uppersの各レベルからremoveBitsを外す。接続が空になったレベルはキーごと落とし、
// 全レベルが空になったらundefinedを返す({1: undefined}のような「truthyな空」を
// 残さないため)。
const maskUppers = (
  uppers: NonNullable<CellData['uppers']>,
  removeBits: number
): CellData['uppers'] => {
  const next: NonNullable<CellData['uppers']> = {};
  let any = false;
  for (const lvl of ALL_LEVELS) {
    const u = uppers[lvl];
    if (!u?.connections) continue;
    const remaining = u.connections & ~removeBits;
    if (remaining === 0) continue;
    next[lvl] = remaining === u.connections ? u : { ...u, connections: remaining };
    any = true;
  }
  return any ? next : undefined;
};

// 撤去によって坂の行き先(登った先の橋桁 or 隣の坂セル)が無くなった場合、
// その坂を地平/下位レベルの通常線路に戻す(ramp fieldだけを外す。connectionsはそのまま)。
// 多段の坂(base>=1)は撤去セルの8近傍の外にも連鎖する(level2が戻ると、その1つ先の
// level1も行き先を失う)ため、坂を戻したセルを起点にキューで伝播させる。
const revertDanglingRamps = (railMap: Map<string, CellData>, x: number, z: number): void => {
  const queue: Pos[] = [{ x, z }];
  while (queue.length > 0) {
    const p = queue.shift()!;
    for (const off of RAMP_NEIGHBOUR_OFFSETS) {
      const nx = p.x + off.x;
      const nz = p.z + off.z;
      const nKey = toKey(nx, nz);
      const nCell = railMap.get(nKey);
      if (!nCell?.ramp) continue;
      const step = getVectorFromDir(nCell.ramp.dir);
      const targetKey = toKey(nx + step.x, nz + step.z);
      const targetCell = railMap.get(targetKey);
      // ramp.level===2(上段)は登った先が橋桁(uppers[base+1])、level===1(下段)は
      // 登った先が同じ坂のlevel2セル(ramp判定のみで十分)。
      // P8a: 地下の掘割ランプ(base=-1)ではbase+1===0(地平)になるため、その場合だけ
      // uppers[0](存在しない)ではなくconnections(地平線路そのもの)を見る。
      const upperLevel = (nCell.ramp.base ?? 0) + 1;
      const hasUpperTarget = nCell.ramp.level === 2 && (
        upperLevel === 0
          ? !!targetCell?.connections
          : !!targetCell?.uppers?.[upperLevel as Level]?.connections
      );
      if (hasUpperTarget || targetCell?.ramp) continue; // 行き先はまだある
      railMap.set(nKey, { ...nCell, ramp: undefined });
      queue.push({ x: nx, z: nz }); // この坂を頼っていた1つ下の坂も確認する
    }
  }
};

/**
 * 高架セル1枚を撤去する。旧・applyBridgeの「橋は全部まとめて消える」挙動は、
 * 自由に敷ける高架線である以上不適切なため廃止し、撤去対象セルのみを消す。
 * 撤去して坂の行き先が無くなった場合は、その坂も地平の線路に戻す
 * (revertDanglingRampsで撤去セルの周囲だけを見て判定する)。
 */
export function removePath(state: ConstructionState, path: Pos[]): ConstructionState {
  const railMap = new Map(state.railMap);
  const stations = new Map(state.stations);

  path.forEach(pos => {
    const key = toKey(pos.x, pos.z);
    const cell = railMap.get(key);
    if (!cell) return;

    // 高架セル(uppersを持つ)の撤去: 全レベルの桁をまとめて撤去する。地平の
    // connectionsも独立して存在する場合はuppersだけを消して地平の線路(下を通る
    // 別の経路)を残す。地平のconnectionsが無ければ(純粋な高架専用セルだった場合)
    // セル自体を丸ごと削除する。
    if (hasAnyUpper(cell)) {
      for (const lvl of ALL_LEVELS) {
        const u = cell.uppers?.[lvl];
        if (u?.stationId) removeElevatedStationCell(stations, u.stationId, pos.x, pos.z, lvl);
      }
      const keepsGround = (cell.connections ?? 0) !== 0;
      if (keepsGround) {
        railMap.set(key, { ...cell, uppers: undefined });
      } else {
        railMap.delete(key);
      }
      RAMP_NEIGHBOUR_OFFSETS.forEach(off => {
        const nKey = toKey(pos.x + off.x, pos.z + off.z);
        const nCell = railMap.get(nKey);
        if (!nCell) return;
        // off は「消えたセル→隣接セル」の向き。隣接セル側から見て消えたセルへ戻る
        // ビットは、その逆方向(隣接セル→消えたセル、すなわちoffの反対)になる。
        const dirTowardsRemoved = getOppositeDir(getDirFromVector(off.x, off.z));
        let updated = nCell;
        // 隣接する高架セルのuppers[L].connectionsから、消えたこのセルへ向かうビットを外す
        if (nCell.uppers) {
          updated = { ...updated, uppers: maskUppers(nCell.uppers, dirTowardsRemoved) };
        }
        // セル自体が消えた(地平の線路も残らない)場合は、隣接セルの地平接続ビットも
        // 掃除する。これを省くと、坂セルの地平の腕などが存在しないセルへ向かって
        // 宙に伸びたまま残る。
        if (!keepsGround && nCell.connections) {
          updated = { ...updated, connections: nCell.connections & ~dirTowardsRemoved };
        }
        if (updated !== nCell) railMap.set(nKey, updated);
      });
      revertDanglingRamps(railMap, pos.x, pos.z);
      return;
    }

    railMap.delete(key);
    revertDanglingRamps(railMap, pos.x, pos.z);
    if (cell.type === 'station' && cell.stationId) {
      const sid = cell.stationId;
      const st = stations.get(sid);
      if (st) {
        const newCells = st.cells.filter(c => c.x !== pos.x || c.z !== pos.z);
        if (newCells.length === 0) {
          stations.delete(sid);
        } else {
          const cx = newCells.reduce((sum, c) => sum + c.x, 0) / newCells.length;
          const cz = newCells.reduce((sum, c) => sum + c.z, 0) / newCells.length;
          stations.set(sid, { ...st, cells: newCells, center: { x: cx, z: cz } });
        }
      }
    }

    const neighbours = [
      { x: pos.x, z: pos.z - 1, opp: DIR.S },
      { x: pos.x + 1, z: pos.z - 1, opp: DIR.SW },
      { x: pos.x + 1, z: pos.z, opp: DIR.W },
      { x: pos.x + 1, z: pos.z + 1, opp: DIR.NW },
      { x: pos.x, z: pos.z + 1, opp: DIR.N },
      { x: pos.x - 1, z: pos.z + 1, opp: DIR.NE },
      { x: pos.x - 1, z: pos.z, opp: DIR.E },
      { x: pos.x - 1, z: pos.z - 1, opp: DIR.SE },
    ];
    neighbours.forEach(n => {
      const nKey = toKey(n.x, n.z);
      const nCell = railMap.get(nKey);
      if (nCell) {
        // 撤去は地平・高架(全レベル)の両方のconnectionsから該当ビットを消す。
        let updated = nCell;
        if (nCell.connections) {
          updated = { ...updated, connections: nCell.connections & ~n.opp };
        }
        if (nCell.uppers) {
          updated = { ...updated, uppers: maskUppers(nCell.uppers, n.opp) };
        }
        if (updated !== nCell) railMap.set(nKey, updated);
        if (nCell.type === 'depot') updateDepotRotation(railMap, n.x, n.z);
      }
    });
  });

  return { railMap, stations };
}
