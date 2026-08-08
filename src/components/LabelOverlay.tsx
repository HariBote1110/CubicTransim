// R4c: WebGPUモードのDOMラベルオーバーレイ。drei <Html> の代替。
//
// r3f の Canvas の外側(App.tsx)に、absolute な素の DIV として重ねる。位置は
// render/labelOverlay.ts の worldToOverlayPx を使い、rAF ループで直接 style.transform を
// 書き換える(React の再レンダーを位置更新のたびに走らせない。項目の中身(content)が
// 変わったときだけ通常の React 再レンダーが走る)。
//
// classicモードでは使わない(StationLabel/TownLabels/DynamicTrainのHtmlをそのまま使う)。

import React, { useEffect, useRef } from 'react';
import { worldToOverlayPx, isOnScreen } from '../render/labelOverlay';
import type { WebGpuCameraState } from '../render/webgpuCamera';

export interface LabelOverlayItem {
  key: string;
  world: { x: number; y: number; z: number };
  content: React.ReactNode;
  /** アンカー位置(既定は中央下寄せ=ラベルの下端がworld座標に来る、Htmlのcenterと近い見た目)。 */
  anchor?: 'bottom-centre' | 'centre';
}

interface Props {
  /** WebGpuCameraSync が毎フレーム書き込む最新カメラ状態。 */
  cameraStateRef: React.RefObject<WebGpuCameraState | null>;
  items: readonly LabelOverlayItem[];
}

const anchorTransform = (anchor: LabelOverlayItem['anchor']): string =>
  anchor === 'centre' ? 'translate(-50%, -50%)' : 'translate(-50%, -100%)';

export const LabelOverlay: React.FC<Props> = ({ cameraStateRef, items }) => {
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const rafRef = useRef<number | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    const tick = () => {
      const camera = cameraStateRef.current;
      if (camera) {
        const dpr = window.devicePixelRatio || 1;
        for (const item of itemsRef.current) {
          const el = itemRefs.current.get(item.key);
          if (!el) continue;
          const pos = worldToOverlayPx(item.world, camera, dpr);
          if (!isOnScreen(pos)) {
            el.style.display = 'none';
            continue;
          }
          el.style.display = '';
          el.style.transform = `translate(${pos.left}px, ${pos.top}px) ${anchorTransform(item.anchor)}`;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [cameraStateRef]);

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {items.map(item => (
        <div
          key={item.key}
          ref={(el) => {
            if (el) itemRefs.current.set(item.key, el);
            else itemRefs.current.delete(item.key);
          }}
          style={{ position: 'absolute', left: 0, top: 0, willChange: 'transform' }}
        >
          {item.content}
        </div>
      ))}
    </div>
  );
};
