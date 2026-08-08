// レンダラー選択(従来 three.js / WebGPU実験版)の永続化。
//
// セーブデータ(sim/persistence.ts)ではなく localStorage に置く: 端末の GPU 事情に
// 依存する表示設定であり、セーブを別端末へ持ち込んだときに引きずるべきではないため。

export type RendererMode = 'classic' | 'webgpu';

const STORAGE_KEY = 'cubictransim.rendererMode';

export const loadRendererMode = (): RendererMode => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'webgpu' ? 'webgpu' : 'classic';
  } catch {
    return 'classic';
  }
};

export const saveRendererMode = (mode: RendererMode): void => {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // プライベートブラウジング等で書けない場合は黙って諦める(既定=従来)。
  }
};
