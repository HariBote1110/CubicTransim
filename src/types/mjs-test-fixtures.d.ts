// R4c: renderer/tools/glbTestFixtures.mjs(Node向けの.mjs、型無し)をテストからimportする際の
// アンビエント宣言。ビルド本体では使わない(*.test.ts からのみ参照)。
declare module '*/glbTestFixtures.mjs' {
  export function buildGlb(nodeSpecs: unknown, extraJson?: unknown): Uint8Array;
  export function boxPositionsIndices(
    cx: number, cy: number, cz: number, hx: number, hy: number, hz: number
  ): { positions: number[][]; indices: number[] };
  export function buildValidTrainGlb(): Uint8Array;
}
