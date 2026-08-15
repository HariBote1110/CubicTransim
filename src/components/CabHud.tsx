// D3: 運転台視点(mode='cab')のときだけ出すHUDオーバーレイ。
// D4: 手動運転(進捗計画 progress/dream-modes-plan.md フェーズD4)のノッチ表示・
// 入力(キーボード↑↓・Space・画面ボタン)・難易度バッジ・停車採点トーストもここに追加した。
//
// 値はすべて `render/cabHud.ts` の `computeCabHud`(純関数、sim層のロジックを
// 複製しない)から読む。sim層は一切変更しない(タスク仕様どおり)ので、ここは
// 低頻度ポーリング(HUD_POLL_INTERVAL_MS)でworld/runtimesを読むだけのDOM表示に徹する。
// D4のノッチ変更・難易度選択だけは、D2/D3のriderStateと同じ「モジュール単位の
// ミュータブルフラグ(ここではworld.current.manualDrive)を直接書き換える」パターンで
// 即座に反映する(Reactステートを経由するとポーリング間隔ぶん遅れるため)。

import React, { useEffect, useState } from 'react';
import type { SimWorld } from '../sim/simulation';
import { computeCabHud, type CabHudInfo } from '../render/cabHud';
import {
  stepNotch, createManualRideTally,
  type ManualNotch, type ManualDifficulty,
} from '../sim/manualDrive';
import { T, panel, button, sectionLabel } from '../ui/theme';

/** HUDの更新間隔(ms)。乗客数などの既存ポーリング(GameUI.tsx)と同程度の粒度。 */
const HUD_POLL_INTERVAL_MS = 150;
/** 「停車している」とみなす速度のしきい値(km/h)。出発ボタンの表示判定に使う。 */
const DWELL_SPEED_THRESHOLD_KMH = 1.0;

const DIFFICULTY_LABEL: Record<ManualDifficulty, string> = { easy: 'かんたん', normal: 'ふつう', hard: 'むずかしい' };

interface CabHudProps {
  world: React.RefObject<SimWorld>;
  trainId: string;
}

export const CabHud: React.FC<CabHudProps> = ({ world, trainId }) => {
  const [hud, setHud] = useState<CabHudInfo | null>(null);
  // 難易度未選択(=まだこの列車の手動運転を開始していない)ならピッカーを出す。
  const [awaitingDifficulty, setAwaitingDifficulty] = useState(
    () => world.current?.manualDrive?.trainId !== trainId
  );

  useEffect(() => {
    setAwaitingDifficulty(world.current?.manualDrive?.trainId !== trainId);
  }, [world, trainId]);

  useEffect(() => {
    setHud(world.current ? computeCabHud(world.current, trainId) : null);
    const id = setInterval(() => {
      setHud(world.current ? computeCabHud(world.current, trainId) : null);
    }, HUD_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [world, trainId]);

  // 降車・列車切り替え時は手動運転を終了させる(自動運転へ戻す)。
  useEffect(() => () => {
    if (world.current?.manualDrive?.trainId === trainId) {
      world.current.manualDrive = undefined;
    }
  }, [world, trainId]);

  const setNotch = (notch: ManualNotch) => {
    if (world.current?.manualDrive?.trainId === trainId) world.current.manualDrive.notch = notch;
  };

  useEffect(() => {
    if (awaitingDifficulty) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const manual = world.current?.manualDrive;
      if (!manual || manual.trainId !== trainId) return;
      if (e.key === 'ArrowUp') { setNotch(stepNotch(manual.notch, 1)); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { setNotch(stepNotch(manual.notch, -1)); e.preventDefault(); }
      else if (e.key === ' ' || e.key === 'Spacebar') { setNotch('EB'); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, trainId, awaitingDifficulty]);

  if (awaitingDifficulty) {
    return (
      <div
        data-testid="cab-difficulty-picker"
        style={panel({
          position: 'absolute', left: 16, bottom: 16, zIndex: 20, width: 240,
          display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px',
        })}
      >
        <div style={sectionLabel}>運転モード: 難易度を選択</div>
        {(['easy', 'normal', 'hard'] as const).map(d => (
          <button
            key={d}
            style={button({ compact: false })}
            onClick={() => {
              if (world.current) {
                world.current.manualDrive = { trainId, notch: 'N', difficulty: d, tally: createManualRideTally() };
              }
              setAwaitingDifficulty(false);
            }}
          >
            {DIFFICULTY_LABEL[d]}
          </button>
        ))}
      </div>
    );
  }

  if (!hud) return null;

  const aspectLabel = hud.nextSignalAspect === 'green' ? '開通' : hud.nextSignalAspect === 'red' ? '停止' : '—';
  const aspectColour = hud.nextSignalAspect === 'green'
    ? T.positive
    : hud.nextSignalAspect === 'red' ? T.danger : T.textFaint;
  const manual = hud.manual;
  const isDwelling = hud.speedKmh < DWELL_SPEED_THRESHOLD_KMH;

  return (
    <div
      data-testid="cab-hud"
      style={panel({
        position: 'absolute', left: 16, bottom: 16, zIndex: 20, width: 240,
        display: 'flex', flexDirection: 'column', gap: 7, padding: '12px 14px',
      })}
    >
      {manual && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            padding: '2px 8px', borderRadius: T.radiusPill, fontSize: 10.5, fontWeight: 700,
            background: 'rgba(56,182,255,0.16)', border: `1px solid ${T.accent}`, color: T.accent,
          }}>
            {DIFFICULTY_LABEL[manual.difficulty]}運転
          </span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 36, fontWeight: 800, lineHeight: 1, color: T.text, fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(hud.speedKmh)}
        </span>
        <span style={{ fontSize: 13, color: T.textMuted }}>km/h</span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: T.textFaint, fontVariantNumeric: 'tabular-nums' }}>
          制限 {Math.round(hud.speedLimitKmh)}
        </span>
      </div>

      <div style={{ fontSize: 12, color: T.textMuted, fontVariantNumeric: 'tabular-nums' }}>
        次の停止点まで {hud.nextStopDistanceM !== null ? `${Math.round(hud.nextStopDistanceM)}m` : '—'}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.textMuted }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: aspectColour, flexShrink: 0 }} />
        <span>次信号: {aspectLabel}</span>
      </div>

      {hud.deadSectionAhead && (
        <div style={{
          padding: '4px 8px', borderRadius: T.radiusSm, fontSize: 11.5, fontWeight: 700,
          background: 'rgba(251,191,36,0.16)', border: `1px solid ${T.warning}`, color: T.warning,
        }}>
          デッドセクション接近
        </div>
      )}

      {hud.lastStopScore && (
        <div
          data-testid="cab-stop-score"
          style={{
            padding: '4px 8px', borderRadius: T.radiusSm, fontSize: 11.5, fontWeight: 700,
            background: hud.lastStopScore.withinTolerance ? 'rgba(52,211,153,0.16)' : 'rgba(248,113,113,0.16)',
            border: `1px solid ${hud.lastStopScore.withinTolerance ? T.positive : T.danger}`,
            color: hud.lastStopScore.withinTolerance ? T.positive : T.danger,
          }}
        >
          停車 {hud.lastStopScore.distanceM >= 0 ? '手前' : '奥'}
          {Math.abs(hud.lastStopScore.distanceM).toFixed(1)}m
          ({hud.lastStopScore.withinTolerance ? '合格' : '不合格'}・±{hud.lastStopScore.toleranceM}m以内)
        </div>
      )}

      {manual && (
        <>
          <div style={{ height: 1, background: T.line, margin: '2px 0' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={sectionLabel}>ノッチ</span>
            <span style={{
              marginLeft: 'auto', fontSize: 18, fontWeight: 800, color: T.text,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {manual.notch}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              style={{ ...button({ compact: true }), flex: 1 }}
              onClick={() => setNotch(stepNotch(manual.notch, -1))}
              title="ブレーキを込める(↓キー)"
            >
              ↓ 制動
            </button>
            <button
              style={{ ...button({ compact: true, accent: T.danger, active: manual.notch === 'EB' }), flex: 1 }}
              onClick={() => setNotch('EB')}
              title="非常制動(Spaceキー)"
            >
              非常
            </button>
            <button
              style={{ ...button({ compact: true }), flex: 1 }}
              onClick={() => setNotch(stepNotch(manual.notch, 1))}
              title="力行を強める(↑キー)"
            >
              ↑ 力行
            </button>
          </div>
          {isDwelling && manual.notch !== 'P5' && (
            <button
              data-testid="cab-depart-button"
              style={button({ accent: T.positive })}
              onClick={() => setNotch('P3')}
            >
              出発する
            </button>
          )}
          <div style={{ fontSize: 10.5, color: T.textFaint, fontVariantNumeric: 'tabular-nums' }}>
            停車 {manual.tally.stops}回・合格 {manual.tally.withinToleranceStops}回
            {manual.tally.stops > 0 && ` (平均誤差${(manual.tally.totalAbsErrorM / manual.tally.stops).toFixed(1)}m)`}
          </div>
        </>
      )}
    </div>
  );
};
