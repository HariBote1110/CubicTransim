// UIのデザイントークン。
//
// これまでUIは各所にインラインstyleを直書きしており、角丸・余白・配色・
// フォントサイズがコンポーネントごとにばらついていた。ここに一元化して、
// 「明るいジオラマの上に載る暗いガラスのパネル」という一貫したトーンにする。
import type { CSSProperties } from 'react';

export const T = {
  // --- 色 ---
  ink: 'rgba(14, 20, 28, 0.86)',
  inkSolid: '#0e141c',
  inkSoft: 'rgba(24, 32, 42, 0.72)',
  line: 'rgba(255, 255, 255, 0.14)',
  lineStrong: 'rgba(255, 255, 255, 0.28)',
  text: '#eef3f8',
  textMuted: '#9dabb9',
  textFaint: '#6f7d8b',

  accent: '#38b6ff',
  accentInk: '#04263a',
  positive: '#34d399',
  warning: '#fbbf24',
  danger: '#f87171',
  station: '#f5a524',
  depot: '#4d90d8',
  signal: '#ef4444',
  bridge: '#c98a4b',

  // --- 形 ---
  radius: 10,
  radiusSm: 7,
  radiusPill: 999,
  gap: 8,
  pad: 12,

  // --- 影・ぼかし ---
  shadow: '0 8px 24px rgba(6, 12, 20, 0.35)',
  shadowSm: '0 2px 8px rgba(6, 12, 20, 0.28)',
  blur: 'blur(10px)',

  // --- 文字 ---
  font: "'Hiragino Sans', 'Noto Sans JP', system-ui, -apple-system, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

/** 画面に浮かせるパネルの共通スタイル。 */
export const panel = (extra: CSSProperties = {}): CSSProperties => ({
  background: T.ink,
  color: T.text,
  border: `1px solid ${T.line}`,
  borderRadius: T.radius,
  boxShadow: T.shadow,
  backdropFilter: T.blur,
  WebkitBackdropFilter: T.blur,
  fontFamily: T.font,
  pointerEvents: 'auto',
  ...extra,
});

/** 押せる要素の共通スタイル。active で塗り、accent は差し色。 */
export const button = (opts: {
  active?: boolean;
  accent?: string;
  disabled?: boolean;
  compact?: boolean;
} = {}): CSSProperties => {
  const accent = opts.accent ?? T.accent;
  return {
    appearance: 'none',
    font: 'inherit',
    fontFamily: T.font,
    fontSize: opts.compact ? 12 : 13,
    fontWeight: 600,
    lineHeight: 1.2,
    padding: opts.compact ? '6px 10px' : '8px 13px',
    borderRadius: T.radiusSm,
    border: `1px solid ${opts.active ? accent : T.line}`,
    background: opts.active ? accent : 'rgba(255,255,255,0.06)',
    color: opts.disabled ? T.textFaint : (opts.active ? T.accentInk : T.text),
    cursor: opts.disabled ? 'not-allowed' : 'pointer',
    opacity: opts.disabled ? 0.55 : 1,
    transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
    whiteSpace: 'nowrap',
  };
};

/** 小さな見出し(パネル内のセクションラベル)。 */
export const sectionLabel: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.08em',
  color: T.textFaint,
  marginBottom: 6,
};

/** 金額の表示形式(負値は −¥1,234)。 */
export const formatYen = (n: number): string => {
  const v = Math.floor(n);
  return `${v < 0 ? '−' : ''}¥${Math.abs(v).toLocaleString('ja-JP')}`;
};
