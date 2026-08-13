// 列車外観エディタ(Phase B)のプレビュー駆動。ゲーム本体の WebGpuTerrainLayerController を
// 直接使い、編成(head+mid+tail)をインスタンス描画する。GameScene/WebGpuTrains のような
// React フックには依存せず、rAF ループとカメラ状態をこのクラスだけで完結させる。
import {
  WebGpuTerrainLayerController,
  MESH_INSTANCE_STRIDE,
  type WebGpuUnavailableError,
} from '../../render/webgpuLayer';
import { OVERPASS_HEIGHT } from '../../sim/trackPath';
import { buildCarMeshFromParts } from '../../render/trainMeshBuilder';
import { parseColourHex } from '../../render/bakedMesh';
import type { TrainCarParts } from '../../render/trainPartsSpec';

const MESH_ID_HEAD = 0x9100_0001;
const MESH_ID_MID = 0x9100_0002;

/** 車間spacing(ゲーム本体のcarPositions呼び出しと同じ1.0)。 */
const CAR_SPACING = 1.0;

export interface PreviewCameraState {
  centreX: number;
  centreZ: number;
  pixelsPerUnit: number;
  /** 度(0..360)。編成全体をY軸まわりに回して側面・前後を確認する。 */
  yawDeg: number;
}

/** プレビューが失敗した理由をUIへ伝えるためのコールバック。 */
export type PreviewFailureHandler = (error: WebGpuUnavailableError | Error) => void;

export class TrainEditorPreview {
  private readonly controller: WebGpuTerrainLayerController;
  private readonly canvas: HTMLCanvasElement;

  private constructor(controller: WebGpuTerrainLayerController, canvas: HTMLCanvasElement) {
    this.controller = controller;
    this.canvas = canvas;
  }

  static async create(canvas: HTMLCanvasElement): Promise<TrainEditorPreview> {
    // 平坦プロファイル・小さいhalfExtentで十分(パーツの見た目確認が目的)。
    const controller = await WebGpuTerrainLayerController.create(canvas, 1, 8, 'flat');
    return new TrainEditorPreview(controller, canvas);
  }

  /** 編集中のパーツから head/mid メッシュを再構築し、wgpu へ再登録する。 */
  updateParts(parts: TrainCarParts): void {
    const head = buildCarMeshFromParts(parts.head);
    const mid = buildCarMeshFromParts(parts.mid);
    if (head) this.controller.registerInstancedMesh(MESH_ID_HEAD, head);
    if (mid) this.controller.registerInstancedMesh(MESH_ID_MID, mid);
  }

  /**
   * 編成(head→mid→tail)のインスタンス配列を組み立てて流し込む。
   * yawDeg は編成全体をY軸まわり(原点=編成中心)に回すための角度。カメラは固定の
   * クォータービューなので、位置とyawの両方を回転しないと「側面から見る」効果が出ない
   * (位置だけ据え置きでyawだけ回すと、車体が自転するだけで編成の向きは変わらない)。
   */
  updateInstances(lineColourHex: string, yawDeg: number): void {
    const [tintR, tintG, tintB] = parseColourHex(lineColourHex);
    const yaw = (yawDeg * Math.PI) / 180;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // ローカルz(spacing方向)をyawぶん回した先のワールド(x,z)。
    const rotate = (localZ: number): [number, number] => [localZ * sin, localZ * cos];

    // head(先頭、+Z向き) / mid(中間) / tail(headを180°回転して流用、ゲーム本体と同じ規約)を
    // spacing 1.0 で一直線に並べる。編成の中心(mid)が原点に来るようにする。
    const headData = new Float32Array(MESH_INSTANCE_STRIDE * 2);
    const midData = new Float32Array(MESH_INSTANCE_STRIDE);
    const [hx, hz] = rotate(CAR_SPACING);
    const [tx, tz] = rotate(-CAR_SPACING);
    this.writeInstance(headData, 0, hx, 0, hz, yaw, tintR, tintG, tintB);
    this.writeInstance(headData, 1, tx, 0, tz, yaw + Math.PI, tintR, tintG, tintB);
    this.writeInstance(midData, 0, 0, 0, 0, yaw, tintR, tintG, tintB);

    this.controller.setInstances(MESH_ID_HEAD, headData);
    this.controller.setInstances(MESH_ID_MID, midData);
  }

  private writeInstance(
    data: Float32Array, slot: number,
    x: number, y: number, z: number, yawRad: number,
    tintR: number, tintG: number, tintB: number,
  ): void {
    const offset = slot * MESH_INSTANCE_STRIDE;
    data[offset] = x;
    data[offset + 1] = y;
    data[offset + 2] = z;
    data[offset + 3] = yawRad;
    data[offset + 4] = 0;
    data[offset + 5] = tintR;
    data[offset + 6] = tintG;
    data[offset + 7] = tintB;
    data[offset + 8] = 0;
    data[offset + 9] = 0;
  }

  render(state: { centreX: number; centreZ: number; pixelsPerUnit: number }): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.controller.syncAndRender(
      {
        centreX: state.centreX,
        centreZ: state.centreZ,
        pixelsPerUnit: state.pixelsPerUnit,
        widthPx: Math.max(1, rect.width * dpr),
        heightPx: Math.max(1, rect.height * dpr),
      },
      OVERPASS_HEIGHT,
    );
  }
}
