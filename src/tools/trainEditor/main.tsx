// 列車外観エディタ(Phase B)のエントリポイント。ゲーム本体(src/App.tsx)とは独立した
// ワンオフツール。src/components・src/hooks・src/App.tsx には依存しない
// (render/・sim/physics の型・純関数だけを再利用する)。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { TrainEditorApp } from './TrainEditorApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TrainEditorApp />
  </StrictMode>,
);
