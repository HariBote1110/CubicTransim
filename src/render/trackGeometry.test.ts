import { describe, it, expect } from 'vitest';
import { DIR } from '../utils';
import type * as THREE from './geom';
import {
  buildCellTrackParts, buildRampTrackParts, buildRampAbutmentPart, buildTrackCentreLines,
  buildOverpassSupportParts, buildUndergroundOpeningPart, buildCatenaryParts,
} from './trackGeometry';
import { rampHeightAtPos, rampSegmentPositions } from '../sim/trackPath';

const positionsOf = (geoms: THREE.BufferGeometry[]): number[] =>
  geoms.flatMap(g => Array.from(g.getAttribute('position')!.array as ArrayLike<number>));

describe('buildCellTrackParts: gauge省略時は従来どおりのジオメトリ(byte-identical)', () => {
  it('gauge未指定と旧来のシグネチャ(gauge引数なし)で同一のposition配列になる', () => {
    const withoutArg = buildCellTrackParts(DIR.N | DIR.S, 1, 2, 0, true);
    const withUndefined = buildCellTrackParts(DIR.N | DIR.S, 1, 2, 0, true, undefined);
    expect(positionsOf(withUndefined.rails)).toEqual(positionsOf(withoutArg.rails));
    expect(positionsOf(withUndefined.sleepers)).toEqual(positionsOf(withoutArg.sleepers));
    expect(positionsOf(withUndefined.ballast)).toEqual(positionsOf(withoutArg.ballast));
  });
});

describe('buildCellTrackParts: gaugeでレール間隔・枕木幅が変わる', () => {
  it('762(狭)は1435(標準)よりレール間隔が狭い', () => {
    const narrow = buildCellTrackParts(DIR.N | DIR.S, 0, 0, 0, true, 762);
    const standard = buildCellTrackParts(DIR.N | DIR.S, 0, 0, 0, true, 1435);
    const railX = (g: THREE.BufferGeometry) =>
      Math.abs((g.getAttribute('position')!.array as ArrayLike<number>)[0]);
    expect(railX(narrow.rails[0])).toBeLessThan(railX(standard.rails[0]));
  });

  it('gauge指定時はballast/sleepersの本数がgauge省略時と変わらない(幅だけが変化する)', () => {
    const plain = buildCellTrackParts(DIR.N | DIR.S, 0, 0, 0, true);
    const gauged = buildCellTrackParts(DIR.N | DIR.S, 0, 0, 0, true, 762);
    expect(gauged.sleepers.length).toBe(plain.sleepers.length);
    expect(gauged.rails.length).toBe(plain.rails.length);
    expect(gauged.ballast.length).toBe(plain.ballast.length);
  });
});

describe('buildCatenaryParts: 電化区間の架線ポール・電線', () => {
  it('接続が無いセルは何も生成しない', () => {
    const parts = buildCatenaryParts(0);
    expect(parts.masts.length).toBe(0);
    expect(parts.wires.length).toBe(0);
  });

  it('直線区間は電線を生成し、間引き位置(3セルおき)ではポールも生成する', () => {
    // 原点(0,0)はセル整数インデックス0なのでポール設置セルになる。
    const parts = buildCatenaryParts(DIR.N | DIR.S, 0, 0);
    expect(parts.wires.length).toBeGreaterThan(0);
    expect(parts.masts.length).toBeGreaterThan(0);
  });

  it('間引き対象外のセルではポールを生成しない(電線のみ)', () => {
    const parts = buildCatenaryParts(DIR.E | DIR.W, 1, 0);
    expect(parts.wires.length).toBeGreaterThan(0);
    expect(parts.masts.length).toBe(0);
  });
});

describe('buildCellTrackParts: connections が 0 のセル', () => {
  it('何も生成しない(applyBridgeが作る「地平connectionsが0の橋桁下セル」に幽霊の線路を描かせないため)', () => {
    const parts = buildCellTrackParts(0);
    expect(parts.ballast.length).toBe(0);
    expect(parts.sleepers.length).toBe(0);
    expect(parts.rails.length).toBe(0);
  });
});

describe('buildCellTrackParts: 通常の接続', () => {
  it('直線(N|S)は従来どおりレール・枕木・バラストを生成する', () => {
    const parts = buildCellTrackParts(DIR.N | DIR.S);
    expect(parts.rails.length).toBeGreaterThan(0);
    expect(parts.sleepers.length).toBeGreaterThan(0);
    expect(parts.ballast.length).toBeGreaterThan(0);
  });
});

describe('buildTrackCentreLines: 分岐器の中心線', () => {
  it('単線の交換設備で使う3方向分岐は、本線と分岐線の2本として組み立てる', () => {
    const routes = buildTrackCentreLines(DIR.E | DIR.W | DIR.SE);

    // 中心から3本の腕を放射状に伸ばすのではなく、直線の本線と片側から分かれる
    // 分岐線にする。これによりレールがセル中心で三重に重ならない。
    expect(routes).toHaveLength(2);
    expect(routes[0]).toHaveLength(2);
    expect(routes[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: -0.5, z: 0 }),
      expect.objectContaining({ x: 0.5, z: 0 }),
    ]));
    // 分岐線はセル端の本線へ遠回りで接続せず、本線の途中で合流する。
    expect(routes[1][0]).toEqual(expect.objectContaining({ x: 0.5, z: 0.5 }));
    // 交換線の入口では、分岐は本線の進行元側から離れる。
    expect(routes[1][routes[1].length - 1]).toEqual(expect.objectContaining({ x: -0.175, z: 0 }));
  });
});

describe('rampSegmentPositions: 坂セルの縦断範囲', () => {
  it('地平に接する最初の坂セルは高さ0の境界から始まる', () => {
    expect(rampSegmentPositions(1)).toEqual([0, 0.5]);
    expect(rampSegmentPositions(2)).toEqual([0.5, 1]);
  });
});

describe('buildRampTrackParts: 坂の線路', () => {
  it('低い側(posLow)から高い側(posHigh)へ、rampHeightAtPosの曲線に沿って登る部品を生成する', () => {
    const posLow = 0.1;
    const posHigh = 0.9;
    const parts = buildRampTrackParts(DIR.E, 0, 0, posLow, posHigh);
    expect(parts.rails.length).toBeGreaterThan(0);
    expect(parts.sleepers.length).toBeGreaterThan(0);
    expect(parts.ballast.length).toBeGreaterThan(0);

    // レール全体(複数のサブセグメント)のバウンディングボックスが
    // rampHeightAtPos(posLow)〜rampHeightAtPos(posHigh) の範囲にまたがっていること。
    const lowY = rampHeightAtPos(posLow);
    const highY = rampHeightAtPos(posHigh);
    let overallMin = Infinity;
    let overallMax = -Infinity;
    for (const rail of parts.rails) {
      rail.computeBoundingBox();
      const bb = rail.boundingBox!;
      overallMin = Math.min(overallMin, bb.min.y);
      overallMax = Math.max(overallMax, bb.max.y);
    }
    expect(overallMin).toBeLessThan(lowY + 0.2);
    expect(overallMax).toBeGreaterThan(highY - 0.2);
  });

  it('1セルを複数のサブセグメントに分割し、各分割点の高さがrampHeightAtPosに沿って単調に変化する', () => {
    const segments = 4;
    const posLow = 0;
    const posHigh = 1;
    const parts = buildRampTrackParts(DIR.E, 0, 0, posLow, posHigh, segments);

    // バラストは1セグメントにつき1つ生成されるので、分割数ぶんの本数になる。
    expect(parts.ballast.length).toBe(segments);

    // 各バラスト片の中心yが、境界側から中央側へ向けて単調に増加すること
    // (段差ではなく、rampHeightAtPosに沿った曲線として繋がっていることの確認)。
    const centres = parts.ballast.map(b => {
      b.computeBoundingBox();
      const bb = b.boundingBox!;
      return (bb.min.y + bb.max.y) / 2;
    });
    for (let i = 1; i < centres.length; i++) {
      expect(centres[i]).toBeGreaterThanOrEqual(centres[i - 1]);
    }
  });

  it('不正な方向ビット(接続ではない値)には空を返す', () => {
    const parts = buildRampTrackParts(0, 0, 0, 0, 1);
    expect(parts.rails.length).toBe(0);
  });
});

describe('buildRampAbutmentPart: 坂の橋台くさび', () => {
  it('低い側(posLow=0)で高さ0、高い側(posHigh)でrampHeightAtPos(posHigh)に達するくさび状ジオメトリを生成する', () => {
    const posHigh = 0.5;
    const geo = buildRampAbutmentPart(DIR.E, 0, 0, posHigh, 0);
    expect(geo).not.toBeNull();
    geo!.computeBoundingBox();
    const bb = geo!.boundingBox!;
    expect(bb.min.y).toBeCloseTo(0, 5);
    expect(bb.max.y).toBeCloseTo(rampHeightAtPos(posHigh), 5);
  });

  it('不正な方向ビットには null を返す', () => {
    const geo = buildRampAbutmentPart(0, 0, 0, 0.5, 0);
    expect(geo).toBeNull();
  });

  it('posHighがposLow以下なら null を返す', () => {
    const geo = buildRampAbutmentPart(DIR.E, 0, 0, 0, 0);
    expect(geo).toBeNull();
  });
});

describe('buildRampTrackParts: 空中に架かる坂(base>=1)のバラスト', () => {
  it('base>=1の坂にはバラスト(砂利)を敷かない(宙に浮いた砂利を描かせない)', () => {
    const parts = buildRampTrackParts(DIR.E, 0, 0, 0, 1, 4, 1);
    expect(parts.ballast.length).toBe(0);
    expect(parts.rails.length).toBeGreaterThan(0);
    expect(parts.sleepers.length).toBeGreaterThan(0);
  });

  it('地平に接する坂(base=0)は従来どおりバラスト付き', () => {
    const parts = buildRampTrackParts(DIR.E, 0, 0, 0, 1, 4, 0);
    expect(parts.ballast.length).toBeGreaterThan(0);
  });
});

describe('buildRampAbutmentPart: 合成互換のための属性', () => {
  it('生成するくさびはposition属性を持つ(BoxGeometry製の橋台とマージできるように、非indexed)', () => {
    const geo = buildRampAbutmentPart(DIR.E, 0, 0, 0.5, 0)!;
    expect(geo.getAttribute('position')).toBeDefined();
    expect(geo.index).toBeNull();
  });
});

describe('buildOverpassSupportParts: 橋脚の間引き軸', () => {
  it('分岐ビットが混ざっても、直線の軸(正反対の組)で橋脚の偶奇を決める', () => {
    const originY = 3.2;
    // E-W本線: xの偶奇で交互に橋脚が立つ
    expect(buildOverpassSupportParts(DIR.E | DIR.W, 2, 0, originY).piers).toHaveLength(1);
    expect(buildOverpassSupportParts(DIR.E | DIR.W, 3, 0, originY).piers).toHaveLength(0);
    // NEの分岐が付いても本線(E-W)の交互配置が崩れない(従来はfirstDirBitがNEを
    // 選び、NE軸の偶奇になって本線の並びと食い違い、二重橋脚や欠落が出ていた)
    expect(buildOverpassSupportParts(DIR.NE | DIR.E | DIR.W, 2, 0, originY).piers).toHaveLength(1);
    expect(buildOverpassSupportParts(DIR.NE | DIR.E | DIR.W, 3, 0, originY).piers).toHaveLength(0);
  });
});

describe('buildTrackCentreLines: 曲線本線の外側へ生える分岐', () => {
  it('本線(NE-SE)の両端が分岐(E)と同じ大まかな向きのときは、本線を横切るS字にしない', () => {
    const routes = buildTrackCentreLines(DIR.NE | DIR.SE | DIR.E);
    expect(routes).toHaveLength(2);
    const branch = routes[1];
    // 分岐線(E)は本線の対称軸(z=0)上に留まり、本線の反対側へ回り込まない。
    // 従来は「最も反対向きの本線端」へ必ず寄せていたため、z<0側へ食い込む
    // S字が本線をまたいで描かれていた。
    for (const p of branch) {
      expect(Math.abs(p.z)).toBeLessThan(1e-9);
    }
    expect(branch[branch.length - 1]).toEqual(expect.objectContaining({ x: 0.5, z: 0 }));
  });
});

describe('buildUndergroundOpeningPart: 掘割ランプの地表開口(P8b)', () => {
  it('無効な方向ビットはnullを返す', () => {
    expect(buildUndergroundOpeningPart(0)).toBeNull();
  });

  it('有効な方向ではpit(床)とwallA/wallB(擁壁)の3つのジオメトリを生成する', () => {
    const parts = buildUndergroundOpeningPart(DIR.N, 3, 5);
    expect(parts).not.toBeNull();
    expect(parts!.pit.getAttribute('position')!.count).toBeGreaterThan(0);
    expect(parts!.wallA.getAttribute('position')!.count).toBeGreaterThan(0);
    expect(parts!.wallB.getAttribute('position')!.count).toBeGreaterThan(0);
  });

  it('セル位置(x,z)を変えるとジオメトリの重心もそのぶん移動する(バウンディングボックス中心で確認)', () => {
    const at00 = buildUndergroundOpeningPart(DIR.E, 0, 0)!;
    const at50 = buildUndergroundOpeningPart(DIR.E, 5, 0)!;
    at00.pit.computeBoundingBox();
    at50.pit.computeBoundingBox();
    const cx0 = (at00.pit.boundingBox!.min.x + at00.pit.boundingBox!.max.x) / 2;
    const cx5 = (at50.pit.boundingBox!.min.x + at50.pit.boundingBox!.max.x) / 2;
    expect(cx5 - cx0).toBeCloseTo(5, 5);
  });

  // R4末: 地形メッシュは坑口・開口の有無に関わらず常に不透明な連続面のまま
  // (terrainOverlayで実際に掘り下げない限り、そのセルは必ずy=0の面で覆われる)。
  // pitがy<0にあると、上から見て必ず地形に隠れて完全に不可視になる不具合があった
  // (ブラウザ実機で確認、underground-view-opening-invisible参照)。pit/wallとも
  // 地表面(y=0)以上の高さに置くことで、地形に隠れず必ず見えるようにする。
  it('pitはy座標がすべて0以上になる(地形の下に沈めて隠れさせない)', () => {
    const { pit } = buildUndergroundOpeningPart(DIR.N, 0, 0)!;
    pit.computeBoundingBox();
    expect(pit.boundingBox!.min.y).toBeGreaterThanOrEqual(0);
  });

  it('wallA/wallBはy座標がすべて0以上になる(半分埋まった状態にしない)', () => {
    const { wallA, wallB } = buildUndergroundOpeningPart(DIR.N, 0, 0)!;
    wallA.computeBoundingBox();
    wallB.computeBoundingBox();
    expect(wallA.boundingBox!.min.y).toBeGreaterThanOrEqual(0);
    expect(wallB.boundingBox!.min.y).toBeGreaterThanOrEqual(0);
  });
});
