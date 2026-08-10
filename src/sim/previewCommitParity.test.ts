// 建設プレビュー(sim/buildPreview.tsのevaluateBuild)と実際の建設
// (hooks/useGameLogic.tsのcommitPath)が、同じ入力に対して常に同じ結論を出すことの
// 総当り的な保証。
//
// ユーザー報告「建設できるのに建設できないって表示される」(0.5.0-Alpha-4c)の調査で、
// 「プレビューの判定と実際の建設の判定がずれていないか」を機械的に確かめる必要が生じた。
// commitPathはReactのstateを触るため直接呼べないので、ここではcommitPathの
// switch文と同じ手順(コスト計算→資金判定→apply系の呼び出し→参照比較で変化判定)を
// 写した`commitLikeUseGameLogic`を使い、乱数で作った経路をひたすら両者へ通す。
//
// この写しがuseGameLogic.commitPathとずれたら、それ自体が回帰の兆候なので、
// commitPathを変更したときはこのヘルパーも合わせて更新すること。
import { describe, expect, it } from 'vitest';
import type { CellData, StationAxis, StationData } from '../types';
import { evaluateBuild } from './buildPreview';
import {
  applyRailPath, applyStation, applyDepot, applySignal,
  applyElevatedPath, applyElevatedStation, applyUndergroundPath, applyUndergroundStation,
  removePath,
  resolveElevatedPathEnd, pickElevatedConnection, planElevatedPath, isElevatedConnectPlanBuildable,
  type ConstructionState, type BuildLevel, type ElevatedLevel, type UndergroundLevel,
} from './construction';
import {
  costOfPath, costOfElevatedPath, costOfGroundPathWithRamps, costOfUndergroundPath,
  ELEVATED_STATION_COST, UNDERGROUND_STATION_COST,
} from './economy';
import { createTerrainField, type TerrainField } from './terrainField';

type Pos = { x: number; z: number };
type Mode = 'rail' | 'station' | 'depot' | 'signal' | 'remove';

interface CommitOutcome {
  next: ConstructionState;
  built: boolean;
  cost: number;
}

/** useGameLogic.commitPathの判定手順をそのまま写したもの(Reactのstate更新だけ除く)。 */
const commitLikeUseGameLogic = (
  state: ConstructionState,
  path: Pos[],
  mode: Mode,
  field: TerrainField,
  level: BuildLevel,
  money: number,
  axisHint?: StationAxis,
): CommitOutcome => {
  let result: ConstructionState = state;
  let cost = 0;
  switch (mode) {
    case 'remove':
      result = removePath(state, path);
      break;
    case 'signal':
      cost = costOfPath('signal', path.length);
      if (money < cost) return { next: state, built: false, cost };
      result = applySignal(state, path, field, new Map());
      break;
    case 'station':
      if (level === 0) {
        cost = costOfPath('station', path.length);
        if (money < cost) return { next: state, built: false, cost };
        result = applyStation(state, path[path.length - 1], field, [], axisHint, new Map());
      } else if (level > 0) {
        cost = ELEVATED_STATION_COST;
        if (money < cost) return { next: state, built: false, cost };
        result = applyElevatedStation(state, path[path.length - 1], [], level as ElevatedLevel);
      } else {
        cost = UNDERGROUND_STATION_COST;
        if (money < cost) return { next: state, built: false, cost };
        result = applyUndergroundStation(state, path[path.length - 1], [], level as UndergroundLevel);
      }
      break;
    case 'depot':
      cost = costOfPath('depot', path.length);
      if (money < cost) return { next: state, built: false, cost };
      result = applyDepot(state, path[path.length - 1], field, new Map());
      break;
    case 'rail':
      if (level === 0) {
        let groundRampFlags: boolean[] | null = null;
        if (path.length >= 2) {
          const startEnd = pickElevatedConnection(resolveElevatedPathEnd(state.railMap, path[0]), 0);
          const endEnd = pickElevatedConnection(resolveElevatedPathEnd(state.railMap, path[path.length - 1]), 0);
          if (startEnd.kind === 'connect' || endEnd.kind === 'connect') {
            const plan = planElevatedPath(path.length, startEnd, endEnd, 0);
            if (plan && isElevatedConnectPlanBuildable(state.railMap, path, field, plan)) {
              groundRampFlags = plan.roles.map(r => r.kind === 'ramp');
            }
          }
        }
        cost = groundRampFlags
          ? costOfGroundPathWithRamps(path, field, groundRampFlags)
          : costOfPath('rail', path.length, path, field);
        if (money < cost) return { next: state, built: false, cost };
        result = applyRailPath(state, path, field, new Map());
      } else if (level > 0) {
        const elevatedLevel = level as ElevatedLevel;
        const startEnd = pickElevatedConnection(resolveElevatedPathEnd(state.railMap, path[0]), elevatedLevel);
        const endEnd = pickElevatedConnection(resolveElevatedPathEnd(state.railMap, path[path.length - 1]), elevatedLevel);
        const plan = planElevatedPath(path.length, startEnd, endEnd, elevatedLevel);
        cost = costOfElevatedPath(
          plan ? plan.roles.filter(r => r.kind === 'ramp').length : 0,
          plan ? plan.roles.filter(r => r.kind === 'span').length : 0,
        );
        if (money < cost) return { next: state, built: false, cost };
        result = applyElevatedPath(state, path, field, elevatedLevel, undefined, new Map());
      } else {
        cost = costOfUndergroundPath(path.length);
        if (money < cost) return { next: state, built: false, cost };
        result = applyUndergroundPath(state, path, field, level as UndergroundLevel);
      }
      break;
  }
  const built = result.railMap !== state.railMap || result.stations !== state.stations;
  return { next: built ? result : state, built, cost };
};

describe('プレビューと実際の建設の判定一致(evaluateBuild ⇔ commitPath)', () => {
  it('乱数経路4000回で「プレビューがokかどうか」と「実際に建設できたか」が一致する', () => {
    const field = createTerrainField(12345, 45);
    let rng = 987654321;
    const rnd = (n: number) => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
    const modes: Mode[] = ['rail', 'station', 'depot', 'signal', 'remove'];
    const mismatches: string[] = [];
    let state: ConstructionState = {
      railMap: new Map<string, CellData>(),
      stations: new Map<string, StationData>(),
    };

    for (let iter = 0; iter < 4000; iter++) {
      const mode = modes[rnd(modes.length)];
      const level = ((mode === 'rail' || mode === 'station') ? rnd(7) - 3 : 0) as BuildLevel;
      const x0 = rnd(21) - 10;
      const z0 = rnd(21) - 10;
      const len = 1 + rnd(5);
      const dir = rnd(4);
      const path: Pos[] = [];
      for (let i = 0; i < len; i++) {
        path.push({
          x: x0 + (dir === 1 ? -i : dir === 2 ? 0 : i),
          z: z0 + (dir === 0 || dir === 1 ? 0 : i),
        });
      }
      // GameScene.handlePointerUpと同じ規則: 駅・車庫・信号は末尾1マスだけを使う。
      const target = (mode === 'station' || mode === 'depot' || mode === 'signal')
        ? [path[path.length - 1]]
        : path;
      const axisHint: StationAxis | undefined = mode === 'station' && len > 1
        ? (dir <= 1 ? 'ew' : 'ns')
        : undefined;
      const money = 1e9;

      const preview = evaluateBuild(mode, target, state.railMap, state.stations, field, money, level, new Map());
      const commit = commitLikeUseGameLogic(state, target, mode, field, level, money, axisHint);
      const previewSaysOk = preview.reason === 'ok';
      // 撤去はプレビューが「対象セルに何かある」で判定するため、参照比較(常に新Map)では
      // 比べられない。commit側の判定も同じ規則に合わせる。
      const commitBuilt = mode === 'remove'
        ? target.some(c => state.railMap.has(`${c.x},${c.z}`))
        : commit.built;
      if (previewSaysOk !== commitBuilt || (commitBuilt && preview.cost !== commit.cost)) {
        mismatches.push(
          `#${iter} mode=${mode} level=${level} path=${JSON.stringify(target)} axis=${axisHint}`
          + ` preview=${preview.reason}/${preview.cost} commit=${commitBuilt}/${commit.cost}`,
        );
      }
      state = commit.next;
    }

    expect(mismatches).toEqual([]);
    // 世界が空のままだと何も検証していないのと同じなので、実際に建った量も確かめる。
    expect(state.railMap.size).toBeGreaterThan(100);
    expect(state.stations.size).toBeGreaterThan(5);
  });
});
