import { useState, useRef, useEffect } from 'react';
import { toKey } from '../utils';
import type { CellData, CellType, TrainData, TrainGroupData, StationData, PlatformDoorType, TownData, TerrainType } from '../types';
import type { SimWorld, SimEvent } from '../sim/simulation';
import { serialiseWorld, deserialiseWorld, emptyLedger } from '../sim/persistence';
import type { SaveData } from '../sim/persistence';
import { applyRailPath, applyStation, applyDepot, applySignal, removePath } from '../sim/construction';
import type { ConstructionState } from '../sim/construction';
import {
  STARTING_MONEY, TRAIN_COST, costOfPath,
  PLATFORM_DOOR_STANDARD_COST, PLATFORM_DOOR_FULLSCREEN_COST,
  calculateUpkeep, CAR_COST, CAR_REFUND,
} from '../sim/economy';

// 編成の最小・最大両数
const MIN_CARS = 1;
const MAX_CARS = 8;
import type { MonthlyLedger } from '../sim/economy';
import { LOAN_STEP, monthlyInterest, repayLoan, takeLoan } from '../sim/loans';
import { mulberry32, generateTowns } from '../sim/towns';
import { effectiveSchedule, nextGroupName, nextGroupColour, findGroup } from '../sim/groups';
import { generateTerrain } from '../sim/terrain';

const SAVE_KEY = 'cubictransim-save-v1';

// 台帳履歴として保持する直近ヶ月数。
const LEDGER_HISTORY_LIMIT = 12;

// 事故バナー表示用の通知の生存確認間隔(ms)。該当列車のhaltRemainingが0になったら消す。
const ACCIDENT_POLL_INTERVAL_MS = 500;

export interface AccidentNotice {
  trainId: string;
  stationId: string;
}

export const useGameLogic = () => {
  const [railMap, setRailMap] = useState<Map<string, CellData>>(new Map());
  const [stations, setStations] = useState<Map<string, StationData>>(new Map());
  const [trains, setTrains] = useState<TrainData[]>([]);

  // ★追加: 新規ゲームの決定的生成に使う共通シード。terrain→townsの順で同じ乱数の系譜から生成する
  // (townsの生成は水域・山岳セルを避けるためterrainが先に必要)。
  const [worldSeed] = useState<number>(() => Date.now() % 2 ** 31);

  // ★追加: 地形(水域・山岳)。初回起動(セーブなしの新規状態)ではシード付き乱数で自動生成する。
  // ロード時はセーブデータ(v5以降)のterrainで置き換わる(v4以前は terrain=空Map になる)。
  const [terrain, setTerrain] = useState<Map<string, TerrainType>>(() =>
    generateTerrain(mulberry32(worldSeed))
  );

  // ★追加: 街(town)。初回起動(セーブなしの新規状態)ではシード付き乱数で自動生成する。
  // ロード時はセーブデータ(v4以降)のtownsで置き換わる(v3以前は towns=[] になる)。
  // 街は必ず平地に生成されるよう、terrainを渡して水域・山岳付近を除外する。
  const [towns, setTowns] = useState<TownData[]>(() =>
    generateTowns(mulberry32(worldSeed + 1), 8, terrain)
  );
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>(null);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);
  const [isEditingSchedule, setIsEditingSchedule] = useState(false);

  // ★追加: 人身事故の通知(バナー表示用)。列車のhaltRemainingが尽きたら自動的に消える。
  const [activeAccidents, setActiveAccidents] = useState<AccidentNotice[]>([]);

  // ★追加: スケジュール用クリップボード
  const [scheduleClipboard, setScheduleClipboard] = useState<string[] | null>(null);

  // ★追加: 所持金。建設・列車購入のたびに減算し、運賃収入で増加する。マイナスも許容する(赤字表示のみ)。
  const [money, setMoney] = useState<number>(STARTING_MONEY);

  // ★追加: 借入残高。序盤に建設しすぎて列車を買えず詰むのを防ぐための資金繰り手段。
  // 月末に残高に応じた利息を支払う(sim/loans.ts)。
  const [loan, setLoan] = useState<number>(0);

  // ★追加: 駅停車位置設定(OpenTTD流のNear/Middle/Far)。ゲーム全体設定。既定値'middle'。
  const [stopLocation, setStopLocation] = useState<'near' | 'middle' | 'far'>('middle');

  // ★追加: 運用グループ(共有運行表＋発車間隔)。所属列車はグループの運行表に従う。
  const [groups, setGroups] = useState<TrainGroupData[]>([]);

  // ★追加: 月次収支台帳。今月の途中経過(currentLedger)と、確定済み直近12ヶ月(ledgerHistory)。
  const [currentLedger, setCurrentLedger] = useState<MonthlyLedger>(emptyLedger());
  const [ledgerHistory, setLedgerHistory] = useState<MonthlyLedger[]>([]);

  // シミュレーション世界の実体。runtimes/waitingは列車ID/駅IDごとに保持し続け、
  // railMap/stations/trainsはReact stateが更新されるたびに差し替える。
  const worldRef = useRef<SimWorld>({
    railMap: new Map(),
    stations: new Map(),
    trains: [],
    runtimes: new Map(),
    waiting: new Map(),
    rng: Math.random,
    economyMirror: { money: STARTING_MONEY },
    towns,
    terrain,
    clock: { elapsed: 0 },
    stopLocation: 'middle',
    groups: [],
    groupDepartures: new Map(),
  });

  useEffect(() => {
    worldRef.current.railMap = railMap;
  }, [railMap]);

  useEffect(() => {
    worldRef.current.stations = stations;
  }, [stations]);

  useEffect(() => {
    worldRef.current.trains = trains;
  }, [trains]);

  useEffect(() => {
    worldRef.current.towns = towns;
  }, [towns]);

  useEffect(() => {
    worldRef.current.terrain = terrain;
  }, [terrain]);

  // economyMirrorはデバッグ/表示用のReact state鏡写しで、simロジックからは参照されない。
  useEffect(() => {
    worldRef.current.economyMirror = { money };
  }, [money]);

  useEffect(() => {
    worldRef.current.stopLocation = stopLocation;
  }, [stopLocation]);

  useEffect(() => {
    worldRef.current.groups = groups;
  }, [groups]);

  // ★追加: 事故バナーの自動消去。該当列車のhaltRemainingが尽きたら通知を取り除く。
  useEffect(() => {
    const id = setInterval(() => {
      setActiveAccidents(prev =>
        prev.filter(a => {
          const rt = worldRef.current.runtimes.get(a.trainId);
          return rt ? rt.haltRemaining > 0 : false;
        })
      );
    }, ACCIDENT_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // --- Commit Path ---
  // railMap/stations の更新ロジックは sim/construction.ts の純粋関数に委譲する。
  // ここでは現在の state を渡し、結果をまとめて setRailMap/setStations するだけの薄いラッパー。
  // 建設コストの算出・所持金チェック・課金もここで行う。
  const commitPath = (path: { x: number; z: number }[], buildMode: CellType | 'none' | 'remove' | 'signal') => {
    if (path.length === 0) return;

    const state: ConstructionState = { railMap, stations };
    let result: ConstructionState;
    let cost = 0;

    switch (buildMode) {
      case 'remove':
        // 撤去は無料・払い戻しなし
        result = removePath(state, path);
        break;
      case 'signal':
        cost = costOfPath('signal', path.length);
        if (money < cost) return;
        result = applySignal(state, path, terrain);
        break;
      case 'station':
        cost = costOfPath('station', path.length);
        if (money < cost) return;
        result = applyStation(state, path[path.length - 1], terrain);
        break;
      case 'depot':
        cost = costOfPath('depot', path.length);
        if (money < cost) return;
        result = applyDepot(state, path[path.length - 1], terrain);
        break;
      case 'rail':
        // 水域(橋)・山岳(トンネル)を通る区間はコストが割増になる
        cost = costOfPath('rail', path.length, path, terrain);
        if (money < cost) return;
        result = applyRailPath(state, path, terrain);
        break;
      default:
        return;
    }

    // no-op(上書き防止などで変化が無かった)場合は課金しない。
    // construction.ts の apply 系は変化が無ければ同一参照を返す実装になっている。
    const changed = result.railMap !== state.railMap || result.stations !== state.stations;
    if (changed && cost > 0) {
      setMoney(m => m - cost);
      setCurrentLedger(l => ({ ...l, construction: l.construction + cost }));
    }

    setRailMap(result.railMap);
    setStations(result.stations);
  };

  const removeSignal = (x: number, z: number) => {
     setRailMap(prev => {
       const newMap = new Map(prev);
       const key = toKey(x, z);
       const cell = newMap.get(key);
       if (cell) {
         newMap.set(key, { ...cell, signalDir: undefined });
       }
       return newMap;
     });
  };

  const handleTrainArrive = (trainId: string, currentIndex: number) => {
    setTrains(prev => prev.map(t => {
      if (t.id !== trainId) return t;
      // グループ所属中は共有運行表の長さで巡回させる
      const schedule = effectiveSchedule(t, worldRef.current.groups ?? []);
      if (schedule.length === 0) return t;
      return { ...t, scheduleIndex: (currentIndex + 1) % schedule.length };
    }));
  };

  const buyTrain = (x: number, z: number) => {
    if (money < TRAIN_COST) return;
    const newTrain: TrainData = {
        id: Math.random().toString(36).substr(0, 4),
        x, z,
        schedule: [], scheduleIndex: 0, status: 'stored',
        cars: 2,
    };
    setTrains(prev => [...prev, newTrain]);
    setSelectedTrainId(newTrain.id);
    setIsEditingSchedule(false);
    setMoney(m => m - TRAIN_COST);
    setCurrentLedger(l => ({ ...l, construction: l.construction + TRAIN_COST }));
  };

  // ★追加: 増結(車庫在籍中の列車のみ想定。running中はGameUI側でボタンを非表示にする)。
  // 8両超は不可、資金不足時は不可。増結費用は月次台帳のconstructionに計上する。
  const addCar = (trainId: string) => {
    const target = trains.find(t => t.id === trainId);
    if (!target) return;
    if (target.cars >= MAX_CARS) return;
    if (money < CAR_COST) return;
    setTrains(prev => prev.map(t => (t.id === trainId ? { ...t, cars: t.cars + 1 } : t)));
    setMoney(m => m - CAR_COST);
    setCurrentLedger(l => ({ ...l, construction: l.construction + CAR_COST }));
  };

  // ★追加: 解結。1両未満にはできない。払い戻しも月次台帳のconstructionに(マイナス計上で)計上する。
  const removeCar = (trainId: string) => {
    const target = trains.find(t => t.id === trainId);
    if (!target) return;
    if (target.cars <= MIN_CARS) return;
    setTrains(prev => prev.map(t => (t.id === trainId ? { ...t, cars: t.cars - 1 } : t)));
    setMoney(m => m + CAR_REFUND);
    setCurrentLedger(l => ({ ...l, construction: l.construction - CAR_REFUND }));
  };

  // ★追加: 運賃収入の反映(sim層の'income'イベントを受けて呼ばれる)
  const addIncome = (amount: number) => {
    setMoney(m => m + amount);
    setCurrentLedger(l => ({ ...l, fares: l.fares + amount }));
  };

  // ★追加: 月次決算(sim層の'monthEnd'イベントを受けて呼ばれる)。
  // 維持費をmoneyから差し引き、確定した台帳を履歴(直近LEDGER_HISTORY_LIMIT件)へpushし、
  // 新しい月の台帳を開始する。
  const handleMonthEnd = (event: Extract<SimEvent, { type: 'monthEnd' }>) => {
    const upkeep = calculateUpkeep(worldRef.current);
    const interest = monthlyInterest(loan);
    setMoney(m => m - upkeep - interest);

    // 確定した台帳。setCurrentLedgerのupdater内でsetLedgerHistoryを呼ぶと、
    // StrictModeがupdaterを二重実行して履歴が重複するため、updaterの外で組み立てる。
    const finalised: MonthlyLedger = {
      ...currentLedger, year: event.year, month: event.month, upkeep, interest,
    };
    setLedgerHistory(prev => [...prev, finalised].slice(-LEDGER_HISTORY_LIMIT));

    const nextMonth = event.month === 12 ? 1 : event.month + 1;
    const nextYear = event.month === 12 ? event.year + 1 : event.year;
    setCurrentLedger({
      year: nextYear, month: nextMonth, fares: 0, construction: 0, upkeep: 0, accidents: 0, interest: 0,
    });
  };

  // ★追加: 借入(LOAN_STEP単位)。上限までしか借りられない。
  const borrow = (amount: number = LOAN_STEP) => {
    const after = takeLoan({ money, loan }, amount);
    setMoney(after.money);
    setLoan(after.loan);
  };

  // ★追加: 返済(LOAN_STEP単位)。手持ちと借入残高の少ないほうまで。
  const repay = (amount: number = LOAN_STEP) => {
    const after = repayLoan({ money, loan }, amount);
    setMoney(after.money);
    setLoan(after.loan);
  };

  const deployTrain = (trainId: string) => {
    setTrains(prev => prev.map(t => {
      if (t.id === trainId) return { ...t, status: 'running' };
      return t;
    }));
    setSelectedTrainId(trainId);
  };

  const addSchedule = (trainId: string, stationId: string) => {
    if (!isEditingSchedule) return;
    // グループに所属している列車の運行表を編集する場合は、グループの共有運行表に足す
    // (同じグループの列車すべてに反映される)。
    const target = trains.find(t => t.id === trainId);
    const group = findGroup(groups, target?.groupId);
    if (group) {
      setGroups(prev => prev.map(g => (g.id === group.id ? { ...g, schedule: [...g.schedule, stationId] } : g)));
      return;
    }
    setTrains(prev => prev.map(t => (
      t.id === trainId ? { ...t, schedule: [...t.schedule, stationId] } : t
    )));
  };

  // --- 運用グループ ---

  /** 新しいグループを作る。列車を指定するとその運行表を引き継いで所属させる。 */
  const createGroup = (seedTrainId?: string) => {
    const seed = seedTrainId ? trains.find(t => t.id === seedTrainId) : undefined;
    const group: TrainGroupData = {
      id: `g${Math.random().toString(36).slice(2, 8)}`,
      name: nextGroupName(groups),
      schedule: seed ? [...seed.schedule] : [],
      headwaySeconds: 0,
      colour: nextGroupColour(groups),
    };
    setGroups(prev => [...prev, group]);
    if (seed) {
      setTrains(prev => prev.map(t => (t.id === seed.id ? { ...t, groupId: group.id } : t)));
    }
    return group.id;
  };

  /** 列車の所属グループを変える(nullで未所属に戻す)。 */
  const assignTrainToGroup = (trainId: string, groupId: string | null) => {
    setTrains(prev => prev.map(t => {
      if (t.id !== trainId) return t;
      // 巡回位置は共有運行表の長さを超えないように丸める
      const next = groupId ? findGroup(groups, groupId) : undefined;
      const len = next ? next.schedule.length : t.schedule.length;
      const index = len > 0 ? t.scheduleIndex % len : 0;
      return { ...t, groupId: groupId ?? undefined, scheduleIndex: index };
    }));
  };

  const setGroupHeadway = (groupId: string, headwaySeconds: number) => {
    setGroups(prev => prev.map(g => (g.id === groupId ? { ...g, headwaySeconds } : g)));
  };

  const renameGroup = (groupId: string, name: string) => {
    setGroups(prev => prev.map(g => (g.id === groupId ? { ...g, name } : g)));
  };

  const clearGroupSchedule = (groupId: string) => {
    setGroups(prev => prev.map(g => (g.id === groupId ? { ...g, schedule: [] } : g)));
  };

  /** グループを削除し、所属列車はグループの運行表を自分の運行表として引き継ぐ。 */
  const deleteGroup = (groupId: string) => {
    const group = findGroup(groups, groupId);
    setTrains(prev => prev.map(t => (
      t.groupId === groupId
        ? { ...t, groupId: undefined, schedule: group ? [...group.schedule] : t.schedule }
        : t
    )));
    setGroups(prev => prev.filter(g => g.id !== groupId));
  };

  const selectTrain = (id: string | null) => {
    setSelectedTrainId(id);
    setIsEditingSchedule(false);
    setSelectedStationId(null);
  };

  // ★追加: 駅選択(列車選択とは排他)。列車未選択かつスケジュール編集中でない場合のみ
  // GameScene側から呼ばれる。
  const selectStation = (id: string | null) => {
    setSelectedStationId(id);
    setSelectedTrainId(null);
    setIsEditingSchedule(false);
  };

  // ★追加: ホームドアのアップグレード。ダウングレードは不可。
  const upgradeStationDoors = (stationId: string, doorType: PlatformDoorType) => {
    const target = stations.get(stationId);
    if (!target) return;
    if (doorType === 'standard' && target.platformDoors !== 'none') return;
    if (doorType === 'fullscreen' && target.platformDoors === 'fullscreen') return;

    const cost = doorType === 'fullscreen' ? PLATFORM_DOOR_FULLSCREEN_COST : PLATFORM_DOOR_STANDARD_COST;
    if (money < cost) return;

    setStations(prev => {
      const next = new Map(prev);
      const st = next.get(stationId);
      if (!st) return prev;
      next.set(stationId, { ...st, platformDoors: doorType });
      return next;
    });
    setMoney(m => m - cost);
  };

  // ★追加: 人身事故イベントの反映(賠償金の減算 + バナー通知の追加)
  const handleAccident = (event: Extract<SimEvent, { type: 'accident' }>) => {
    setMoney(m => m - event.penalty);
    setCurrentLedger(l => ({ ...l, accidents: l.accidents + event.penalty }));
    setActiveAccidents(prev => [...prev, { trainId: event.trainId, stationId: event.stationId }]);
  };

  // ★追加: スケジュールコピー機能
  const copySchedule = (trainId: string) => {
    const target = trains.find(t => t.id === trainId);
    if (target) {
      setScheduleClipboard([...target.schedule]);
    }
  };

  // ★追加: スケジュールペースト機能
  const pasteSchedule = (trainId: string) => {
    if (!scheduleClipboard) return;
    setTrains(prev => prev.map(t => {
      if (t.id === trainId) {
        return { ...t, schedule: [...scheduleClipboard], scheduleIndex: 0 };
      }
      return t;
    }));
  };

  // ★追加: セーブ／ロード
  const saveGame = () => {
    const saveData = serialiseWorld(
      railMap, stations, trains, worldRef.current.runtimes, worldRef.current.waiting, money, towns, terrain,
      worldRef.current.clock ?? { elapsed: 0 }, currentLedger, ledgerHistory, stopLocation,
      groups, worldRef.current.groupDepartures ?? new Map(), loan,
      worldRef.current.demand ?? new Map()
    );
    localStorage.setItem(SAVE_KEY, JSON.stringify(saveData));
  };

  const loadGame = () => {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) {
      console.warn('No save data found.');
      return;
    }
    const saveData = JSON.parse(raw) as SaveData;
    const restored = deserialiseWorld(saveData);

    setRailMap(restored.railMap);
    setStations(restored.stations);
    setTrains(restored.trains);
    setMoney(restored.money);
    setLoan(restored.loan);
    setTowns(restored.towns);
    setTerrain(restored.terrain);
    setCurrentLedger(restored.currentLedger);
    setLedgerHistory(restored.ledgerHistory);
    setStopLocation(restored.stopLocation);
    setGroups(restored.groups);

    // runtimes/waiting は DynamicTrain/StationLabel が Map インスタンスを参照し続けているため、
    // 差し替えず中身だけ入れ替える。clockも同様にworldRef上のオブジェクトを直接更新する。
    worldRef.current.runtimes.clear();
    restored.runtimes.forEach((rt, id) => worldRef.current.runtimes.set(id, rt));
    worldRef.current.waiting.clear();
    restored.waiting.forEach((count, id) => worldRef.current.waiting.set(id, count));
    worldRef.current.clock = restored.clock;
    worldRef.current.stopLocation = restored.stopLocation;
    worldRef.current.groups = restored.groups;
    worldRef.current.groupDepartures = restored.groupDepartures;
    worldRef.current.demand = restored.demand;
    // 経路キャッシュは列車・運行表が入れ替わったので捨てる(次のstepWorldで組み直される)。
    worldRef.current.serviceSignature = undefined;
  };

  return {
    railMap, setRailMap,
    stations, setStations,
    trains, setTrains,
    towns,
    terrain,
    selectedTrainId, setSelectedTrainId: selectTrain,
    isEditingSchedule, setIsEditingSchedule,
    commitPath, removeSignal,
    handleTrainArrive,
    buyTrain, deployTrain,
    addCar, removeCar,
    addSchedule,
    worldRef,
    // 公開
    scheduleClipboard,
    copySchedule,
    pasteSchedule,
    saveGame,
    loadGame,
    // ★追加: 経済システム
    money,
    addIncome,
    // ★追加: 借入
    loan,
    borrow,
    repay,
    // ★追加: 人身事故とホームドア
    selectedStationId,
    selectStation,
    upgradeStationDoors,
    activeAccidents,
    handleAccident,
    // ★追加: 月次決算(収支台帳)
    currentLedger,
    ledgerHistory,
    handleMonthEnd,
    // ★追加: 駅停車位置設定(Near/Middle/Far)
    stopLocation,
    setStopLocation,
    // ★追加: 運用グループ(共有運行表＋発車間隔)
    groups,
    createGroup,
    assignTrainToGroup,
    setGroupHeadway,
    renameGroup,
    clearGroupSchedule,
    deleteGroup,
  };
};