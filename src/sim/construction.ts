import { toKey, getDirFromVector, getOppositeDir, getVectorFromDir, DIR } from '../utils';
import type { CellData, StationData, TerrainType, TownData } from '../types';
import { terrainAt } from './terrain';
import { nearestTownWithinRadius, stationNameForTown } from './towns';

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

// 隣接する既存の線路・駅セルから軸を推測する。南北方向に隣接セルがあればns、
// 東西方向にあればew、両方あればcross(交差)。何も無ければ東西(ew)を既定にする。
const inferStationAxis = (railMap: Map<string, CellData>, x: number, z: number): StationAxis => {
  const hasNeighbourCell = (nx: number, nz: number): boolean => {
    const c = railMap.get(toKey(nx, nz));
    return !!c && (c.type === 'rail' || c.type === 'station');
  };
  const hasNS = hasNeighbourCell(x, z - 1) || hasNeighbourCell(x, z + 1);
  const hasEW = hasNeighbourCell(x - 1, z) || hasNeighbourCell(x + 1, z);
  if (hasNS && hasEW) return 'cross';
  if (hasNS) return 'ns';
  if (hasEW) return 'ew';
  return 'ew';
};

// terrain省略時は空Map(=すべて平地)扱いにする。既存呼び出し・既存テストとの互換のため。
const EMPTY_TERRAIN: Map<string, TerrainType> = new Map();

// セルが水域・山岳かどうか(駅・車庫・信号は平地にしか置けない)。
const isBuildableGround = (terrain: Map<string, TerrainType>, x: number, z: number): boolean =>
  terrainAt(terrain, x, z) === 'grass';

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

// terrainに応じたbridge/tunnelフラグ(描画用)。平地ならどちらも付かない。
const terrainFlags = (terrain: Map<string, TerrainType>, x: number, z: number): Pick<CellData, 'bridge' | 'tunnel'> => {
  const t = terrainAt(terrain, x, z);
  if (t === 'water') return { bridge: true };
  if (t === 'mountain') return { tunnel: true };
  return { bridge: undefined, tunnel: undefined };
};

// 既存セルにdir方向の接続を1つ足す。常に地平のconnectionsへOR(平面交差方式)。
// 直角に交差する線路は4方向接続の1セル(ダイヤモンドクロッシング)になる。
const addConnectionToCell = (
  railMap: Map<string, CellData>,
  key: string,
  x: number,
  z: number,
  dir: number,
  terrain: Map<string, TerrainType>
): void => {
  const existing = railMap.get(key);
  if (!existing) {
    railMap.set(key, { type: 'rail', connections: dir, ...terrainFlags(terrain, x, z) });
  } else if (existing.type !== 'rail') {
    railMap.set(key, { ...existing, connections: (existing.connections || 0) | dir });
  } else {
    railMap.set(key, { ...existing, connections: (existing.connections || 0) | dir, ...terrainFlags(terrain, x, z) });
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
export function applyRailPathDetailed(
  state: ConstructionState,
  path: Pos[],
  terrain: Map<string, TerrainType> = EMPTY_TERRAIN
): RailPathApplyResult {
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

    addConnectionToCell(railMap, currKey, curr.x, curr.z, dir, terrain);
    if (railMap.get(currKey)?.type === 'depot') updateDepotRotation(railMap, curr.x, curr.z);

    addConnectionToCell(railMap, nextKey, next.x, next.z, oppDir, terrain);
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

export function applyRailPath(state: ConstructionState, path: Pos[], terrain: Map<string, TerrainType> = EMPTY_TERRAIN): ConstructionState {
  return applyRailPathDetailed(state, path, terrain);
}

export function applyStation(
  state: ConstructionState,
  pos: Pos,
  terrain: Map<string, TerrainType> = EMPTY_TERRAIN,
  towns: TownData[] = [],
  axis?: StationAxis
): ConstructionState {
  const key = toKey(pos.x, pos.z);
  const existingBeforeUpdate = state.railMap.get(key);

  // 駅は平地にしか置けない: 水域・山岳セルへの設置は no-op(課金もされない)
  if (!isBuildableGround(terrain, pos.x, pos.z)) {
    return state;
  }

  // 車庫があるセルへの設置は従来通り no-op(車庫が消えないように)
  if (existingBeforeUpdate && existingBeforeUpdate.type === 'depot') {
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
  // (何も無ければ東西を既定にする)。
  const resolvedAxis: StationAxis = axis ?? inferStationAxis(state.railMap, pos.x, pos.z);
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

export function applyDepot(state: ConstructionState, pos: Pos, terrain: Map<string, TerrainType> = EMPTY_TERRAIN): ConstructionState {
  const key = toKey(pos.x, pos.z);
  const existing = state.railMap.get(key);

  // 車庫は平地にしか置けない: 水域・山岳セルへの設置は no-op(課金もされない)
  if (!isBuildableGround(terrain, pos.x, pos.z)) {
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

export function applySignal(state: ConstructionState, path: Pos[], terrain: Map<string, TerrainType> = EMPTY_TERRAIN): ConstructionState {
  const pos = path[0];
  const key = toKey(pos.x, pos.z);
  const cell = state.railMap.get(key);
  if (!cell || (cell.type !== 'rail' && cell.type !== 'station')) return state;
  // 信号は平地にしか置けない: 橋・トンネル区間(水域・山岳)への設置は no-op
  if (!isBuildableGround(terrain, pos.x, pos.z)) return state;

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

/** 経路の端(始点 or 終点)が、既存の高架へ継ぎ足す形になるかどうかを判定する。 */
export function resolveElevatedPathEnd(
  railMap: Map<string, CellData>,
  pos: Pos
): { continuesElevated: boolean } {
  const existing = railMap.get(toKey(pos.x, pos.z));
  return { continuesElevated: !!existing?.upper?.connections };
}

export type ElevatedCellRole =
  | { kind: 'span' }
  | { kind: 'ramp'; side: 'start' | 'end'; level: 1 | 2 };

export interface ElevatedPathPlan {
  roles: ElevatedCellRole[];
}

/**
 * 経路の各セルに「坂(どちら側の・どの段の)」か「橋桁」かを割り当てる。
 * 割り当てが物理的に矛盾する(坂に必要なセル数が経路長を超える、あるいは
 * 継ぎ足し先の高架セルを坂で上書きしてしまう)場合は null を返す。
 */
export function planElevatedPath(
  length: number,
  startContinuesElevated: boolean,
  endContinuesElevated: boolean
): ElevatedPathPlan | null {
  if (length < 2) return null;

  const startRamp = !startContinuesElevated;
  const endRamp = !endContinuesElevated;

  const rampZoneStart = startRamp ? [0, 1] : [];
  const rampZoneEnd = endRamp ? [length - 2, length - 1] : [];
  // 継ぎ足し先(高架のまま続く端)は絶対にrampで上書きしてはいけない保護インデックス。
  const protectedIndices = new Set<number>([
    ...(!startRamp ? [0] : []),
    ...(!endRamp ? [length - 1] : []),
  ]);

  const rampIndices = new Set<number>([...rampZoneStart, ...rampZoneEnd]);
  if (rampIndices.size < rampZoneStart.length + rampZoneEnd.length) return null; // 坂同士が重なる
  for (const idx of rampIndices) {
    if (protectedIndices.has(idx)) return null; // 坂が継ぎ足し先を潰してしまう
  }

  const roles: ElevatedCellRole[] = new Array(length).fill(null).map(() => ({ kind: 'span' as const }));
  if (startRamp) {
    roles[0] = { kind: 'ramp', side: 'start', level: 1 };
    roles[1] = { kind: 'ramp', side: 'start', level: 2 };
  }
  if (endRamp) {
    roles[length - 1] = { kind: 'ramp', side: 'end', level: 1 };
    roles[length - 2] = { kind: 'ramp', side: 'end', level: 2 };
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
 * - 橋桁になるセルに、この経路の継ぎ足し元でない既存のupperがある(二重架け禁止)
 */
export function applyElevatedPath(
  state: ConstructionState,
  path: Pos[],
  terrain: Map<string, TerrainType> = EMPTY_TERRAIN
): ConstructionState {
  if (path.length < 2) return state;
  for (let i = 0; i < path.length - 1; i++) {
    const dx = path[i + 1].x - path[i].x;
    const dz = path[i + 1].z - path[i].z;
    if (getDirFromVector(dx, dz) === 0) return state;
  }

  const startInfo = resolveElevatedPathEnd(state.railMap, path[0]);
  const endInfo = resolveElevatedPathEnd(state.railMap, path[path.length - 1]);
  const plan = planElevatedPath(path.length, startInfo.continuesElevated, endInfo.continuesElevated);
  if (!plan) return state;

  // 車庫セルは高架にできない(坂・橋桁いずれも)
  for (const cell of path) {
    if (state.railMap.get(toKey(cell.x, cell.z))?.type === 'depot') return state;
  }

  // 坂になるセルは建設可能な地面の上にしか置けない
  for (let i = 0; i < path.length; i++) {
    if (plan.roles[i].kind === 'ramp' && !isBuildableGround(terrain, path[i].x, path[i].z)) return state;
  }

  // 橋桁セルに既にupperがある場合は二重架け禁止(ただし継ぎ足し元の端は許容)
  for (let i = 0; i < path.length; i++) {
    if (plan.roles[i].kind !== 'span') continue;
    const isContinuationAnchor =
      (i === 0 && startInfo.continuesElevated) || (i === path.length - 1 && endInfo.continuesElevated);
    if (isContinuationAnchor) continue;
    if (state.railMap.get(toKey(path[i].x, path[i].z))?.upper) return state;
  }

  const railMap = new Map(state.railMap);
  const dirBetween = (a: number, b: number): number =>
    getDirFromVector(path[b].x - path[a].x, path[b].z - path[a].z);

  for (let i = 0; i < path.length; i++) {
    const role = plan.roles[i];
    const key = toKey(path[i].x, path[i].z);
    const prevDir = i > 0 ? dirBetween(i, i - 1) : 0;
    const nextDir = i < path.length - 1 ? dirBetween(i, i + 1) : 0;

    if (role.kind === 'span') {
      const axisBits = prevDir | nextDir;
      const existing = railMap.get(key);
      const groundConnections = (existing?.connections ?? 0) & ~axisBits;
      railMap.set(key, {
        ...(existing ?? { type: 'rail' }),
        connections: groundConnections,
        upper: { connections: (existing?.upper?.connections ?? 0) | axisBits, stationId: existing?.upper?.stationId },
      });
    } else {
      const bits = prevDir | nextDir;
      const existing = railMap.get(key);
      const baseConnections =
        existing && (existing.type === 'rail' || existing.type === 'station')
          ? (existing.connections || 0) | bits
          : bits;
      const rampDir = role.side === 'start' ? nextDir : prevDir;
      railMap.set(key, {
        ...(existing ?? { type: 'rail' }),
        type: existing?.type ?? 'rail',
        connections: baseConnections,
        ...terrainFlags(terrain, path[i].x, path[i].z),
        ramp: { dir: rampDir, level: role.level },
      });
      if (railMap.get(key)?.type === 'depot') updateDepotRotation(railMap, path[i].x, path[i].z);
    }
  }

  return { railMap, stations: state.stations };
}

// 旧・固定長の橋(2セルずつの坂+中間が桁、直線のみ)。自由な高架線(applyElevatedPath)へ
// 置き換えられたが、既存の呼び出し元(pathfinding/reservation/simulationのテスト等)との
// 後方互換のため薄いラッパーとして残す。振る舞いはapplyElevatedPathに委譲する
// (新規に敷く直線区間であれば、両端2セルずつが坂になる従来通りの構成になる)。
export function applyBridge(
  state: ConstructionState,
  path: Pos[],
  terrain: Map<string, TerrainType> = EMPTY_TERRAIN
): ConstructionState {
  return applyElevatedPath(state, path, terrain);
}

/**
 * 高架セル1枚に駅タイルを置く。applyStationと対になる関数で、地平の駅設置と同じ
 * 考え方(隣接する既存の駅への統合)を高架層(upper)向けに再利用する。
 *
 * - 対象セルが高架の線路(upper.connectionsを持つ)でなければ no-op
 *   (先にapplyElevatedPathで高架線を敷いてからでないと駅は置けない)。
 * - 既に高架駅(upper.stationId)なら no-op。
 * - 同じ(x,z)に地平駅セル(type==='station')があれば、その駅IDへ統合する
 *   (立体交差の十字乗換駅は、地平と高架をそれぞれ別々に敷いてから、この関数で
 *   重ねて置くことで手作業で作れる)。
 * - 隣接する高架駅セルがあれば、その駅IDへ統合する(高架ホームの延伸)。
 */
export function applyElevatedStation(
  state: ConstructionState,
  pos: Pos,
  towns: TownData[] = []
): ConstructionState {
  const key = toKey(pos.x, pos.z);
  const existing = state.railMap.get(key);
  if (!existing?.upper?.connections) return state; // 高架の線路が無ければ駅は置けない
  if (existing.upper.stationId) return state; // 既に高架駅

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
  if (existing.type === 'station' && existing.stationId) pushId(existing.stationId);
  for (const n of neighbours) {
    const cell = state.railMap.get(toKey(n.x, n.z));
    if (cell?.upper?.stationId) pushId(cell.upper.stationId);
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
    const cellMap = new Map<string, { x: number; z: number; layer?: 0 | 1 }>();
    keepSt.cells.forEach(c => cellMap.set(`${toKey(c.x, c.z)}|${c.layer ?? 0}`, c));
    for (let i = 1; i < involvedIds.length; i++) {
      const removeId = involvedIds[i];
      const removeSt = stations.get(removeId);
      if (!removeSt) continue;
      removeSt.cells.forEach(c => {
        cellMap.set(`${toKey(c.x, c.z)}|${c.layer ?? 0}`, c);
        const ck = toKey(c.x, c.z);
        const cell = railMap.get(ck);
        if (cell?.upper?.stationId === removeId) {
          railMap.set(ck, { ...cell, upper: { ...cell.upper, stationId: targetId } });
        }
        if (cell?.type === 'station' && cell.stationId === removeId) {
          railMap.set(ck, { ...cell, stationId: targetId });
        }
      });
      stations.delete(removeId);
    }
    cellMap.set(`${key}|1`, { x: pos.x, z: pos.z, layer: 1 });
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
      cells: [{ x: pos.x, z: pos.z, layer: 1 }],
      center: { x: pos.x, z: pos.z },
      platformDoors: 'none',
    });
  }

  railMap.set(key, { ...existing, upper: { ...existing.upper, stationId: targetId } });
  return { railMap, stations };
}

// 高架駅のホームセル(x,z)をstations Mapから取り除く(layer:1のcellのみ対象)。
// 撤去後にセルが0になった駅は消す。地平ホーム(layer 0)は別途、既存の
// cell.type==='station'経路(removePath内)で扱うため、ここでは触らない。
const removeElevatedStationCell = (
  stations: Map<string, StationData>,
  sid: string,
  x: number,
  z: number
): void => {
  const st = stations.get(sid);
  if (!st) return;
  const newCells = st.cells.filter(c => !(c.x === x && c.z === z && c.layer === 1));
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

// 撤去によって坂の行き先(登った先の橋桁 or 隣の坂セル)が無くなった場合、
// その坂を地平の通常線路に戻す(ramp fieldだけを外す。connectionsはそのまま)。
// 撤去したセルの直近8方向だけを見れば十分(1セルずつ順に消していく運用を想定)。
const revertDanglingRamps = (railMap: Map<string, CellData>, x: number, z: number): void => {
  for (const off of RAMP_NEIGHBOUR_OFFSETS) {
    const nx = x + off.x;
    const nz = z + off.z;
    const nKey = toKey(nx, nz);
    const nCell = railMap.get(nKey);
    if (!nCell?.ramp) continue;
    const step = getVectorFromDir(nCell.ramp.dir);
    const targetKey = toKey(nx + step.x, nz + step.z);
    const targetCell = railMap.get(targetKey);
    if (targetCell?.upper?.connections || targetCell?.ramp) continue; // 行き先はまだある
    railMap.set(nKey, { ...nCell, ramp: undefined });
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

    // 高架セル(upperを持つ)の撤去: 地平のconnectionsも独立して存在する場合は
    // upperだけを消して地平の線路(下を通る別の経路)を残す。地平のconnectionsが
    // 無ければ(純粋な高架専用セルだった場合)セル自体を丸ごと削除する。
    if (cell.upper?.connections) {
      if (cell.upper.stationId) removeElevatedStationCell(stations, cell.upper.stationId, pos.x, pos.z);
      if ((cell.connections ?? 0) !== 0) {
        railMap.set(key, { ...cell, upper: undefined });
      } else {
        railMap.delete(key);
      }
      // 隣接する高架セルのupper.connectionsから、消えたこのセルへ向かうビットを外す
      RAMP_NEIGHBOUR_OFFSETS.forEach(off => {
        const nKey = toKey(pos.x + off.x, pos.z + off.z);
        const nCell = railMap.get(nKey);
        if (!nCell?.upper?.connections) return;
        // off は「消えたセル→隣接セル」の向き。隣接セル側から見て消えたセルへ戻る
        // ビットは、その逆方向(隣接セル→消えたセル、すなわちoffの反対)になる。
        const dirTowardsRemoved = getOppositeDir(getDirFromVector(off.x, off.z));
        const remaining = nCell.upper.connections & ~dirTowardsRemoved;
        railMap.set(nKey, { ...nCell, upper: remaining === 0 ? undefined : { ...nCell.upper, connections: remaining } });
      });
      revertDanglingRamps(railMap, pos.x, pos.z);
      return;
    }

    if (cell.upper?.stationId) removeElevatedStationCell(stations, cell.upper.stationId, pos.x, pos.z);

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
        // 撤去は地平・高架の両方のconnectionsから該当ビットを消す。
        let updated = nCell;
        if (nCell.connections) {
          updated = { ...updated, connections: nCell.connections & ~n.opp };
        }
        if (nCell.upper?.connections) {
          const remainingUpper = nCell.upper.connections & ~n.opp;
          updated = { ...updated, upper: remainingUpper === 0 ? undefined : { ...nCell.upper, connections: remainingUpper } };
        }
        if (updated !== nCell) railMap.set(nKey, updated);
        if (nCell.type === 'depot') updateDepotRotation(railMap, n.x, n.z);
      }
    });
  });

  return { railMap, stations };
}
