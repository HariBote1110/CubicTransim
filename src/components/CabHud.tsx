// D3: 運転台視点(mode='cab')のときだけ出すHUDオーバーレイ。
//
// 値はすべて `render/cabHud.ts` の `computeCabHud`(純関数、sim層のロジックを
// 複製しない)から読む。sim層は一切変更しない(タスク仕様どおり)ので、ここは
// 低頻度ポーリング(HUD_POLL_INTERVAL_MS)でworld/runtimesを読むだけのDOM表示に徹する。

import React, { useEffect, useState } from 'react';
import type { SimWorld } from '../sim/simulation';
import { computeCabHud, type CabHudInfo } from '../render/cabHud';
import { T, panel } from '../ui/theme';

/** HUDの更新間隔(ms)。乗客数などの既存ポーリング(GameUI.tsx)と同程度の粒度。 */
const HUD_POLL_INTERVAL_MS = 150;

interface CabHudProps {
  world: React.RefObject<SimWorld>;
  trainId: string;
}

export const CabHud: React.FC<CabHudProps> = ({ world, trainId }) => {
  const [hud, setHud] = useState<CabHudInfo | null>(null);

  useEffect(() => {
    setHud(world.current ? computeCabHud(world.current, trainId) : null);
    const id = setInterval(() => {
      setHud(world.current ? computeCabHud(world.current, trainId) : null);
    }, HUD_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [world, trainId]);

  if (!hud) return null;

  const aspectLabel = hud.nextSignalAspect === 'green' ? '開通' : hud.nextSignalAspect === 'red' ? '停止' : '—';
  const aspectColour = hud.nextSignalAspect === 'green'
    ? T.positive
    : hud.nextSignalAspect === 'red' ? T.danger : T.textFaint;

  return (
    <div
      data-testid="cab-hud"
      style={panel({
        position: 'absolute', left: 16, bottom: 16, zIndex: 20, width: 220,
        display: 'flex', flexDirection: 'column', gap: 7, padding: '12px 14px',
      })}
    >
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
    </div>
  );
};
