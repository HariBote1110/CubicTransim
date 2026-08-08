import { describe, expect, it, vi } from 'vitest';
import { FrameLoop, FRAME_ORDER } from './frameLoop';

describe('FrameLoop', () => {
  it('runs subscribers in ascending order value', () => {
    const loop = new FrameLoop();
    const calls: string[] = [];
    loop.subscribe(FRAME_ORDER.render, () => calls.push('render'));
    loop.subscribe(FRAME_ORDER.simulation, () => calls.push('sim'));
    loop.subscribe(FRAME_ORDER.feed, () => calls.push('feed'));
    loop.runFrame(0.016);
    expect(calls).toEqual(['sim', 'feed', 'render']);
  });

  it('keeps the registration order stable within one order value', () => {
    const loop = new FrameLoop();
    const calls: string[] = [];
    loop.subscribe(FRAME_ORDER.feed, () => calls.push('a'));
    loop.subscribe(FRAME_ORDER.feed, () => calls.push('b'));
    loop.runFrame(0);
    expect(calls).toEqual(['a', 'b']);
  });

  it('passes the delta through to subscribers', () => {
    const loop = new FrameLoop();
    const seen: number[] = [];
    loop.subscribe(FRAME_ORDER.simulation, dt => seen.push(dt));
    loop.runFrame(0.25);
    expect(seen).toEqual([0.25]);
  });

  it('stops calling a subscriber once it unsubscribes', () => {
    const loop = new FrameLoop();
    const spy = vi.fn();
    const off = loop.subscribe(FRAME_ORDER.feed, spy);
    loop.runFrame(0);
    off();
    loop.runFrame(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('tolerates a subscriber unsubscribing during the frame it is running', () => {
    const loop = new FrameLoop();
    const later = vi.fn();
    const off = loop.subscribe(FRAME_ORDER.feed, () => off());
    loop.subscribe(FRAME_ORDER.render, later);
    expect(() => loop.runFrame(0)).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('keeps running the remaining subscribers when one throws', () => {
    const loop = new FrameLoop();
    const after = vi.fn();
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    loop.subscribe(FRAME_ORDER.feed, () => { throw new Error('boom'); });
    loop.subscribe(FRAME_ORDER.render, after);
    loop.runFrame(0);
    expect(after).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('counts the frames it has run', () => {
    const loop = new FrameLoop();
    expect(loop.frameCount).toBe(0);
    loop.runFrame(0);
    loop.runFrame(0);
    expect(loop.frameCount).toBe(2);
  });

  it('clamps very large deltas so a backgrounded tab cannot teleport the simulation', () => {
    const loop = new FrameLoop();
    const seen: number[] = [];
    loop.subscribe(FRAME_ORDER.simulation, dt => seen.push(dt));
    loop.runFrame(loop.maxDelta * 10);
    expect(seen).toEqual([loop.maxDelta]);
  });
});
