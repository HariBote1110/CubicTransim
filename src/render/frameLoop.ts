// R4d: 素の requestAnimationFrame オーケストレータ。r3f の useFrame を置き換える。
//
// 1フレームで走る順序は固定:
//   simulation → feed(メッシュチャンク/インスタンスの載せ替え) → camera → render
// 従来は r3f の描画ループがこの順序を暗黙に決めていた(useFrame の登録順)。
// wgpu 一本化後は「シミュレーションを進める → その結果をGPUへ載せる → 1回だけ描く」を
// 明示的に並べる必要があるため、優先度つきの購読バスにした。
//
// React/THREE には依存しない(テスト可能な素のクラス)。React 側は useFrameLoop で購読する。

export type FrameCallback = (deltaSeconds: number) => void;

/** 購読の優先度。小さいほど先に走る。 */
export const FRAME_ORDER = {
  simulation: 0,
  feed: 10,
  camera: 20,
  render: 30,
} as const;

interface Subscription {
  order: number;
  seq: number;
  callback: FrameCallback;
}

export class FrameLoop {
  /** 1フレームで進める最大の秒数(タブ復帰直後の巨大な delta でシミュレーションが飛ばないように)。 */
  readonly maxDelta = 0.1;

  private subscriptions: Subscription[] = [];
  private seq = 0;
  private rafId: number | null = null;
  private lastTime: number | null = null;
  private frames = 0;

  get frameCount(): number {
    return this.frames;
  }

  subscribe(order: number, callback: FrameCallback): () => void {
    const entry: Subscription = { order, seq: this.seq++, callback };
    this.subscriptions.push(entry);
    this.subscriptions.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
    return () => {
      const index = this.subscriptions.indexOf(entry);
      if (index >= 0) this.subscriptions.splice(index, 1);
    };
  }

  /** 1フレーム分を同期的に走らせる(rAF が止まる非表示タブでの __dbgStep からも使う)。 */
  runFrame(deltaSeconds: number): void {
    const dt = Math.min(this.maxDelta, Math.max(0, deltaSeconds));
    // 実行中の unsubscribe / subscribe に耐えるようスナップショットを取る。
    for (const entry of [...this.subscriptions]) {
      try {
        entry.callback(dt);
      } catch (error) {
        console.error('[frameLoop] subscriber failed', error);
      }
    }
    this.frames += 1;
  }

  start(): void {
    if (this.rafId !== null) return;
    const tick = (now: number) => {
      const delta = this.lastTime === null ? 0 : (now - this.lastTime) / 1000;
      this.lastTime = now;
      this.runFrame(delta);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.lastTime = null;
  }
}

/** アプリ全体で1つだけ使う共有ループ。 */
export const frameLoop = new FrameLoop();
