import { toKey, fromKey, getDirFromVector, getOppositeDir, getVectorFromDir, DIR } from '../utils';
import type { CellData, StationData, TerrainType, TownData } from '../types';
import { terrainAt } from './terrain';
import { nearestTownWithinRadius, stationNameForTown } from './towns';

// 橋の全長(坂4セル含む)の下限・上限。坂は両端2セルずつ固定なので、
// 5未満は橋桁が0になり橋の意味が無く、12を超える長さは建設UIの想定外
// (コストも高額になりすぎる)としてno-opにする。
export const MAX_BRIDGE_LENGTH = 12;
const MIN_BRIDGE_LENGTH = 5;

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

  railMap.set(key, { type: 'station', connections, stationId: targetId });
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

// TTD/OpenTTD流の橋・高架駅に共通する「坂+橋桁」構築ロジック。
// 始点・終点それぞれから2セルずつが坂(地平の通常線路+ramp)、残る中間セルが
// 橋桁(upper.connectionsのみ。地平のconnectionsは一切変更しない)になる。
// 坂を2セル(level1→level2)にすることで、1セルで一気に登っていた急勾配を緩くする。
// これにより橋の下に平面交差(ダイヤモンドクロッシング)や別の地平線路を通せる。
//
// applyBridge(単なる橋)とapplyElevatedStation(高架駅)の両方から使う共通部分を
// ここに集約する(高架駅は橋桁セルの一部にupper.stationIdを追加で設定するだけの差分)。
//
// 建設不可条件(いずれか1つでも該当すれば null を返す):
// - 全長(path.length)が MIN_BRIDGE_LENGTH 未満 or MAX_BRIDGE_LENGTH 超
// - 始点〜終点が8方向直線上に等間隔で並んでいない
// - 坂になる4セル(両端2セルずつ)が水域・山岳
// - 橋桁セル(坂を除いた中間)が車庫
// - 橋桁セルが駅の場合、allowStationSpanがfalseならno-op
//   (地平駅の上を高架駅・高架橋が跨げるようにするための緩和。ただし「地平駅の上に
//   駅でない単なる橋桁を架ける」ことまで許すのは安全側でないと判断し、
//   applyBridge自身は従来通り禁止のままにしている。詳細はprogressを参照)
// - 橋桁セルに既にupperがある(二重架け禁止)
interface OverpassCoreResult {
  railMap: Map<string, CellData>;
  /** 橋桁(坂を除いた中間セル)。高架駅ではこれがそのままホームセルになる。 */
  spanCells: Pos[];
}

function buildOverpassCore(
  state: ConstructionState,
  path: Pos[],
  terrain: Map<string, TerrainType>,
  allowStationSpan: boolean
): OverpassCoreResult | null {
  if (path.length < MIN_BRIDGE_LENGTH || path.length > MAX_BRIDGE_LENGTH) return null;

  const start = path[0];
  const second = path[1];
  const end = path[path.length - 1];
  const dir = getDirFromVector(second.x - start.x, second.z - start.z);
  if (dir === 0) return null; // 隣接しない/同一セル指定など

  const oppDir = getOppositeDir(dir);
  const step = getVectorFromDir(dir);

  // 始点から終点までstep刻みの直線上に等間隔で並んでいるか(斜めも含む8方向)確認する
  for (let i = 0; i < path.length; i++) {
    const expectedX = start.x + step.x * i;
    const expectedZ = start.z + step.z * i;
    if (path[i].x !== expectedX || path[i].z !== expectedZ) return null;
  }

  // 坂になる4セル(両端2セルずつ)は水域・山岳に置けない
  const rampPositions = [path[0], path[1], path[path.length - 2], path[path.length - 1]];
  for (const cell of rampPositions) {
    if (!isBuildableGround(terrain, cell.x, cell.z)) return null;
  }

  // 橋桁(坂を除いた中間セル)は車庫でないこと、既にupperが無いこと。
  // 駅は allowStationSpan の場合のみ許容する(高架駅・高架橋が地平駅を跨ぐケース)。
  const spanCells = path.slice(2, path.length - 2);
  for (const cell of spanCells) {
    const existing = state.railMap.get(toKey(cell.x, cell.z));
    if (existing && existing.type === 'depot') return null;
    if (existing && existing.type === 'station' && !allowStationSpan) return null;
    if (existing?.upper) return null;
  }

  const railMap = new Map(state.railMap);

  // 坂・橋桁を通して、経路全体に通常の地平線路として接続を敷設する
  // (橋桁セルはこの後upper化する際に軸ビットを取り除くので、最終的に
  // 地平のconnectionsが残るのは坂の4セルだけになる)。
  for (let i = 0; i < path.length - 1; i++) {
    const curr = path[i];
    const next = path[i + 1];
    addConnectionToCell(railMap, toKey(curr.x, curr.z), curr.x, curr.z, dir, terrain);
    addConnectionToCell(railMap, toKey(next.x, next.z), next.x, next.z, oppDir, terrain);
  }
  if (railMap.get(toKey(start.x, start.z))?.type === 'depot') updateDepotRotation(railMap, start.x, start.z);
  if (railMap.get(toKey(end.x, end.z))?.type === 'depot') updateDepotRotation(railMap, end.x, end.z);

  // 坂: 外側(地平寄り)がlevel1、内側(桁寄り)がlevel2。dirは桁側(登り方向)。
  const setRamp = (cell: Pos, rampDir: number, level: 1 | 2) => {
    const key = toKey(cell.x, cell.z);
    railMap.set(key, { ...railMap.get(key)!, ramp: { dir: rampDir, level } });
  };
  setRamp(path[0], dir, 1);
  setRamp(path[1], dir, 2);
  setRamp(path[path.length - 2], oppDir, 2);
  setRamp(path[path.length - 1], oppDir, 1);

  // 橋桁: upper.connectionsに軸方向の接続(dir|oppDir)を入れる。
  // 地平に同じ軸の線路が既にあれば、橋がそれを置き換えるので該当ビットは取り除く
  // (交差する別方向のビットはそのまま残る。駅セルの場合も同じ式でよい:
  // OR してから同じビットを NOT で消すだけなので元のconnectionsに軸ビットが
  // 無ければ実質変化しない)。
  const axisBits = dir | oppDir;
  for (const cell of spanCells) {
    const key = toKey(cell.x, cell.z);
    const existing = railMap.get(key);
    const groundConnections = (existing?.connections ?? 0) & ~axisBits;
    railMap.set(key, {
      ...(existing ?? { type: 'rail' }),
      connections: groundConnections,
      upper: { connections: axisBits },
    });
  }

  return { railMap, spanCells };
}

export function applyBridge(
  state: ConstructionState,
  path: Pos[],
  terrain: Map<string, TerrainType> = EMPTY_TERRAIN
): ConstructionState {
  const core = buildOverpassCore(state, path, terrain, false);
  if (!core) return state;
  return { railMap: core.railMap, stations: state.stations };
}

/**
 * 立体交差の高架駅。applyBridgeと同じ坂+橋桁のロジックを再利用し、橋桁セル
 * (spanCells)全てをホームにして upper.stationId を設定する。
 *
 * 橋桁セルが地平駅セルであっても建設できる(allowStationSpan=true)。地平駅の
 * 接続(connections)は一切変更しない(高架と地平は独立した層のため)。
 *
 * stationId を渡すと、既存の駅(通常は同じ場所に先に建てた地平駅)へ高架ホーム
 * セルを統合する(1つの駅IDに地平ホーム群と高架ホーム群が両方ぶら下がる形)。
 * 省略時は新しい駅を作る(高架ホームだけの単独駅)。
 *
 * 建設不可条件はbuildOverpassCore(allowStationSpan=true)に準じる
 * (橋桁が車庫、既にupperがある、坂が水域・山岳、等)。
 */
export function applyElevatedStation(
  state: ConstructionState,
  path: Pos[],
  terrain: Map<string, TerrainType> = EMPTY_TERRAIN,
  towns: TownData[] = [],
  stationId?: string
): ConstructionState {
  const core = buildOverpassCore(state, path, terrain, true);
  if (!core) return state;
  if (core.spanCells.length === 0) return state; // 橋桁(ホームになるセル)が無ければ駅にならない

  const railMap = core.railMap;
  const stations = new Map(state.stations);
  const anchor = core.spanCells[0];

  let targetId: string;
  if (stationId && stations.has(stationId)) {
    targetId = stationId;
  } else {
    targetId = Math.random().toString(36).substr(2, 9);
    const newName = stationNameFor(anchor, stations, towns);
    stations.set(targetId, { id: targetId, name: newName, cells: [], center: anchor, platformDoors: 'none' });
  }

  const st = stations.get(targetId)!;
  // 高架ホーム(layer:1)は地平ホーム(layer省略/0)と同じ(x,z)になり得るため、
  // layerも含めたキーで重複判定する(既存の地平ホームcellと衝突させない)。
  const elevatedKey = (x: number, z: number) => `${toKey(x, z)}|1`;
  const existingCellKeys = new Set(st.cells.filter(c => c.layer === 1).map(c => elevatedKey(c.x, c.z)));
  const newCells = [...st.cells];
  for (const cell of core.spanCells) {
    const key = toKey(cell.x, cell.z);
    const existing = railMap.get(key)!;
    railMap.set(key, { ...existing, upper: { ...existing.upper!, stationId: targetId } });
    if (!existingCellKeys.has(elevatedKey(cell.x, cell.z))) {
      newCells.push({ x: cell.x, z: cell.z, layer: 1 });
      existingCellKeys.add(elevatedKey(cell.x, cell.z));
    }
  }
  const cx = newCells.reduce((sum, c) => sum + c.x, 0) / newCells.length;
  const cz = newCells.reduce((sum, c) => sum + c.z, 0) / newCells.length;
  stations.set(targetId, { ...st, cells: newCells, center: { x: cx, z: cz } });

  return { railMap, stations };
}

// セルが橋の一部(橋桁のupper、または坂のramp)かどうかと、その軸(dir|oppDir)を返す。
const bridgeAxisOf = (cell: CellData | undefined): number => {
  if (!cell) return 0;
  if (cell.upper?.connections) return cell.upper.connections;
  if (cell.ramp) return cell.ramp.dir | getOppositeDir(cell.ramp.dir);
  return 0;
};

const DIR_BITS_ALL = [DIR.N, DIR.NE, DIR.E, DIR.SE, DIR.S, DIR.SW, DIR.W, DIR.NW];

// (x,z)から橋の軸方向へ両側にたどり、橋を構成するセル(坂4枚+橋桁)のキー集合を返す。
const collectBridgeCellKeys = (
  railMap: Map<string, CellData>,
  x: number,
  z: number,
  axisBits: number
): Set<string> => {
  const result = new Set<string>([toKey(x, z)]);
  let dirA = 0;
  for (const b of DIR_BITS_ALL) {
    if (axisBits & b) { dirA = b; break; }
  }
  if (!dirA) return result;
  const dirB = getOppositeDir(dirA);

  for (const dirBit of [dirA, dirB]) {
    const step = getVectorFromDir(dirBit);
    let cx = x;
    let cz = z;
    for (;;) {
      cx += step.x;
      cz += step.z;
      const nCell = railMap.get(toKey(cx, cz));
      if (bridgeAxisOf(nCell) !== axisBits) break;
      result.add(toKey(cx, cz));
    }
  }
  return result;
};

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

export function removePath(state: ConstructionState, path: Pos[]): ConstructionState {
  const railMap = new Map(state.railMap);
  const stations = new Map(state.stations);

  // 撤去対象セルが橋の一部(坂/橋桁)なら、橋全体(坂4枚+橋桁)を撤去対象に広げる。
  // ユーザーが橋の一部だけを選んで消しても橋全体が消えるようにするため。
  const targetKeys = new Set<string>(path.map(pos => toKey(pos.x, pos.z)));
  for (const pos of path) {
    const cell = state.railMap.get(toKey(pos.x, pos.z));
    const axisBits = bridgeAxisOf(cell);
    if (!axisBits) continue;
    const bridgeKeys = collectBridgeCellKeys(state.railMap, pos.x, pos.z, axisBits);
    bridgeKeys.forEach(k => targetKeys.add(k));
  }
  const targets: Pos[] = Array.from(targetKeys, k => fromKey(k));

  targets.forEach(pos => {
    const key = toKey(pos.x, pos.z);
    const cell = railMap.get(key);
    if (!cell) return;

    // 橋桁セル(upperを持ち、かつ地平のconnectionsも独立して存在する)をまるごと
    // 撤去した場合は、upperだけを消して地平の線路(下を通る別の経路)を残す。
    // upperが高架駅のホーム(stationIdあり)だった場合は、そのホームセルをstationsからも消す。
    if (cell.upper?.connections && (cell.connections ?? 0) !== 0) {
      if (cell.upper.stationId) removeElevatedStationCell(stations, cell.upper.stationId, pos.x, pos.z);
      railMap.set(key, { ...cell, upper: undefined });
      return;
    }

    if (cell.upper?.stationId) removeElevatedStationCell(stations, cell.upper.stationId, pos.x, pos.z);

    railMap.delete(key);
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
          updated = { ...updated, upper: remainingUpper === 0 ? undefined : { connections: remainingUpper } };
        }
        // 橋(坂+橋桁)は撤去対象を橋全体に広げてまとめて消すため、ここで単独の
        // rampだけを消すケアは不要になった(隣の坂セルも同時に撤去済みのはず)。
        if (updated !== nCell) railMap.set(nKey, updated);
        if (nCell.type === 'depot') updateDepotRotation(railMap, n.x, n.z);
      }
    });
  });

  return { railMap, stations };
}
