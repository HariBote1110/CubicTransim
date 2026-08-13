// R4d: 駅名・町名・選択列車ツールチップの DOM ラベル。drei <Html> の置き換え。
//
// R4c では App.tsx がラベルの中身を組み立てていたが、駅ごとの配置計算
// (computeStationHousePlacement の labelY)と選択列車の停車順が手元に無く、
// three.js 版の <StationLabel> に対して「ラベルの高さが固定 1.35」「停車順バッジ無し」の
// 差分が残っていた。R4d で GameScene(= 配置計算を持っている側)へ移し、両方を復元する。
//
// 位置の追従は LabelOverlay の rAF ループが担い、ここは「中身」だけを 0.5 秒間隔で
// 組み直す(待ち人数・速度の表示更新頻度は three.js 版と同じ)。

import React, { useEffect, useState } from 'react';
import { LabelOverlay, type LabelOverlayItem } from './LabelOverlay';
import type { StationData, TownData, TrainData } from '../types';
import type { SimWorld } from '../sim/simulation';
import type { TerrainField } from '../sim/terrainField';
import type { WebGpuCameraState } from '../render/webgpuCamera';
import type { StationHousePlacement } from '../render/stationLayers';
import { OVERPASS_HEIGHT } from '../sim/trackPath';
import { formatPopulation } from '../render/townGeometry';
import { T } from '../ui/theme';

/** 中身(待ち人数・速度)の再計算間隔[ms]。three.js 版の 0.5 秒と同じ。 */
const CONTENT_REFRESH_MS = 500;

/** ホームドアの設置状況を示すバッジ(StationLabel.tsx から引き継ぎ)。 */
const DOOR_BADGE = {
  none: null,
  standard: { label: '半', title: '標準ホームドア' },
  fullscreen: { label: '全', title: 'フルスクリーンホームドア' },
} as const;

interface Props {
  cameraStateRef: React.RefObject<WebGpuCameraState | null>;
  stations: Map<string, StationData>;
  towns: readonly TownData[];
  trains: readonly TrainData[];
  selectedTrainId: string | null;
  world: React.RefObject<SimWorld>;
  field: TerrainField;
  /** 駅ごとの配置(labelY を使う)。GameScene の useMemo をそのまま受け取る。 */
  housePlacements: Map<string, StationHousePlacement>;
  /** 遠景では判読できないうえ DOM 要素数が無視できなくなるので、まとめて出さない。 */
  hidden?: boolean;
}

export const GameLabels: React.FC<Props> = ({
  cameraStateRef, stations, towns, trains, selectedTrainId, world, field, housePlacements, hidden = false,
}) => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), CONTENT_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  const items: LabelOverlayItem[] = [];
  if (!hidden) {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    tick;
    const simWorld = world.current;
    const selectedTrain = trains.find(t => t.id === selectedTrainId);

    for (const station of stations.values()) {
      const placement = housePlacements.get(station.id);
      if (!placement) continue;
      const waiting = Math.floor(simWorld?.waiting.get(station.id) ?? 0);
      const door = DOOR_BADGE[station.platformDoors];
      // 停車順バッジ(選択中の列車の運行表に含まれる駅のみ)。
      const orderIndices: number[] = [];
      selectedTrain?.schedule.forEach((stationId, index) => {
        if (stationId === station.id) orderIndices.push(index);
      });
      items.push({
        key: `station-${station.id}`,
        anchor: 'centre',
        world: { x: station.center.x, y: placement.labelY, z: station.center.z },
        content: (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            whiteSpace: 'nowrap', fontFamily: T.font,
          }}>
            {orderIndices.length > 0 && (
              <div style={{ display: 'flex', gap: 3, marginBottom: 3 }}>
                {orderIndices.map(index => (
                  <div key={index} style={{
                    background: T.accent, color: T.accentInk, borderRadius: '50%',
                    width: 18, height: 18, fontSize: 11, fontWeight: 700,
                    display: 'grid', placeItems: 'center', boxShadow: T.shadowSm,
                  }}>
                    {index + 1}
                  </div>
                ))}
              </div>
            )}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: T.ink, color: T.text,
              border: `1px solid ${T.line}`, borderRadius: T.radiusPill,
              padding: '3px 9px', fontSize: 11, fontWeight: 600,
              boxShadow: T.shadowSm, backdropFilter: T.blur,
            }}>
              {station.name}
              {door && (
                <span title={door.title} style={{
                  fontSize: 9, fontWeight: 700, color: T.accent,
                  border: `1px solid ${T.accent}`, borderRadius: 3, padding: '0 3px', lineHeight: '12px',
                }}>
                  {door.label}
                </span>
              )}
              <span style={{ color: T.textMuted, fontVariantNumeric: 'tabular-nums' }}>{waiting}人</span>
            </div>
          </div>
        ),
      });
    }

    for (const town of towns) {
      items.push({
        key: `town-${town.id}`,
        anchor: 'centre',
        world: {
          x: town.centre.x,
          y: 2.6 + field.cellHeightAt(town.centre.x, town.centre.z) * OVERPASS_HEIGHT,
          z: town.centre.z,
        },
        content: (
          <div style={{
            background: 'rgba(24,30,38,0.62)', color: '#f2f5f8', padding: '2px 7px',
            borderRadius: '999px', fontSize: '10px', whiteSpace: 'nowrap',
            backdropFilter: 'blur(3px)', border: '1px solid rgba(255,255,255,0.14)',
          }}>
            <span style={{ fontWeight: 700, marginRight: 5 }}>{town.name}</span>
            {formatPopulation(town.population)}
          </div>
        ),
      });
    }

    if (selectedTrainId) {
      const runtime = simWorld?.runtimes.get(selectedTrainId);
      if (runtime && selectedTrain && selectedTrain.status !== 'stored') {
        items.push({
          key: `train-${selectedTrainId}`,
          anchor: 'centre',
          world: { x: runtime.renderPos.x, y: runtime.renderPos.y + 1.6, z: runtime.renderPos.z },
          getWorld: () => {
            const liveRuntime = world.current?.runtimes.get(selectedTrainId);
            if (!liveRuntime) return undefined;
            const p = liveRuntime.renderPos;
            return { x: p.x, y: p.y + 1.6, z: p.z };
          },
          content: (
            <div style={{
              background: 'rgba(17,22,28,0.86)', color: '#f4f7fa', padding: '5px 9px',
              borderRadius: '7px', fontSize: '11px', textAlign: 'center', width: 200,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              border: '1px solid rgba(255,255,255,0.18)', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            }}>
              <div style={{ fontWeight: 700 }}>{selectedTrain.id}</div>
              <div style={{ color: '#8fe3a5', fontWeight: 'bold' }}>{Math.round(runtime.speedKmh)} km/h</div>
              <div style={{ color: '#b9c3cc' }}>{runtime.debugStatus}</div>
            </div>
          ),
        });
      }
    }
  }

  return <LabelOverlay cameraStateRef={cameraStateRef} items={items} />;
};
