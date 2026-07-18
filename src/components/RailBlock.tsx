import React, { useMemo } from 'react';
import * as THREE from 'three';
import { RAIL_COLOUR } from '../types';
import { DIR } from '../utils';

// --- 定数設定 ---
const RAIL_WIDTH = 0.05;
const RAIL_HEIGHT = 0.05;
const RAIL_SPACING = 0.25;
const CURVE_SEGMENTS = 12; // カーブをより滑らかにするため倍増

// 共通マテリアル
const railMaterial = new THREE.MeshStandardMaterial({ color: RAIL_COLOUR });

/**
 * 直線レール (端から端まで 1.0)
 * @param length 長さ
 * @param rotation Y軸回転
 */
const StraightRailPart: React.FC<{ length: number, rotation?: number }> = ({ length, rotation = 0 }) => (
  <group rotation={[0, rotation, 0]}>
    <mesh position={[-RAIL_SPACING / 2, 0, 0]} material={railMaterial}>
      <boxGeometry args={[RAIL_WIDTH, RAIL_HEIGHT, length]} />
    </mesh>
    <mesh position={[RAIL_SPACING / 2, 0, 0]} material={railMaterial}>
      <boxGeometry args={[RAIL_WIDTH, RAIL_HEIGHT, length]} />
    </mesh>
  </group>
);

/**
 * ハーフ・レール (中心から端まで 0.5)
 * T字路の分岐部分などに使用
 * @param length 長さ
 * @param rotation 回転
 * @param offset 中心からのずれ
 */
const HalfRailPart: React.FC<{ length: number, rotation: number, offset: [number, number, number] }> = ({ length, rotation, offset }) => (
  <group position={offset} rotation={[0, rotation, 0]}>
    <mesh position={[-RAIL_SPACING / 2, 0, 0]} material={railMaterial}>
      <boxGeometry args={[RAIL_WIDTH, RAIL_HEIGHT, length]} />
    </mesh>
    <mesh position={[RAIL_SPACING / 2, 0, 0]} material={railMaterial}>
      <boxGeometry args={[RAIL_WIDTH, RAIL_HEIGHT, length]} />
    </mesh>
  </group>
);

/**
 * カーブレール
 */
const CurveRailPart: React.FC<{ startAngle: number, endAngle: number, centerOffset: [number, number, number] }> = ({ startAngle, endAngle, centerOffset }) => {
  const segments: React.JSX.Element[] = [];
  const angleStep = (endAngle - startAngle) / CURVE_SEGMENTS;
  // 隙間を埋めるため、長さをわずかに伸ばす (1.05 -> 1.1)
  const segLength = (0.5 * Math.abs(endAngle - startAngle) / CURVE_SEGMENTS) * 1.1;

  for (let i = 0; i < CURVE_SEGMENTS; i++) {
    const currentAngle = startAngle + angleStep * (i + 0.5);
    const x = Math.sin(currentAngle);
    const z = Math.cos(currentAngle);
    const rot = currentAngle;

    segments.push(
      <group key={i} position={[centerOffset[0] + x * 0.5, 0, centerOffset[2] + z * 0.5]} rotation={[0, rot, 0]}>
        <mesh position={[-RAIL_SPACING/2, 0, 0]} material={railMaterial}>
          <boxGeometry args={[RAIL_WIDTH, RAIL_HEIGHT, segLength]} />
        </mesh>
        <mesh position={[RAIL_SPACING / 2, 0, 0]} material={railMaterial}>
          <boxGeometry args={[RAIL_WIDTH, RAIL_HEIGHT, segLength]} />
        </mesh>
      </group>
    );
  }
  return <group>{segments}</group>;
};

interface RailBlockProps {
  position: [number, number, number];
  connections?: number;
  isPreview?: boolean;
}

/**
 * レール描画コンポーネント (複合描画版)
 */
export const RailBlock: React.FC<RailBlockProps> = ({ position, connections = 0, isPreview = false }) => {
  const railY = position[1] + RAIL_HEIGHT / 2;

  // 接続状況に応じてパーツを組み合わせるロジック
  const RailParts = useMemo(() => {
    // まだ何も接続がない（建設プレビュー中など）場合は縦直線
    if (connections === 0) {
      return <StraightRailPart length={1.0} rotation={0} />;
    }

    const parts: React.JSX.Element[] = [];
    // 処理済みの方向を記録するビットマスク
    let processed = 0;

    // --- 1. 直線ペアの判定 (十字路・直進) ---
    // 南北 (N & S)
    if ((connections & DIR.N) && (connections & DIR.S)) {
      parts.push(<StraightRailPart key="ns" length={1.0} rotation={0} />);
      processed |= (DIR.N | DIR.S);
    }
    // 東西 (E & W)
    if ((connections & DIR.E) && (connections & DIR.W)) {
      parts.push(<StraightRailPart key="ew" length={1.0} rotation={Math.PI / 2} />);
      processed |= (DIR.E | DIR.W);
    }
    // 斜めペア (NE & SW)
    if ((connections & DIR.NE) && (connections & DIR.SW)) {
      parts.push(<StraightRailPart key="nesw" length={Math.sqrt(2)} rotation={-Math.PI / 4} />);
      processed |= (DIR.NE | DIR.SW);
    }
    // 斜めペア (NW & SE)
    if ((connections & DIR.NW) && (connections & DIR.SE)) {
      parts.push(<StraightRailPart key="nwse" length={Math.sqrt(2)} rotation={Math.PI / 4} />);
      processed |= (DIR.NW | DIR.SE);
    }

    // --- 2. 残りの接続を処理 (カーブ または T字の分岐) ---
    // まだ処理されていない方向だけ抽出
    const remaining = connections & ~processed;

    // 残りの方向をリスト化
    const dirs = [];
    if (remaining & DIR.N) dirs.push('N');
    if (remaining & DIR.E) dirs.push('E');
    if (remaining & DIR.S) dirs.push('S');
    if (remaining & DIR.W) dirs.push('W');
    // 斜めは今回カーブ接続しない（ハーフで処理）

    // もし残りが「直角の2方向」だけなら、カーブとして描画
    let curveHandled = false;
    if (dirs.length === 2) {
        if (remaining === (DIR.N | DIR.E)) {
            parts.push(<CurveRailPart key="ne" startAngle={Math.PI} endAngle={Math.PI / 2} centerOffset={[-0.5, 0, 0.5]} />);
            curveHandled = true;
        } else if (remaining === (DIR.E | DIR.S)) {
            parts.push(<CurveRailPart key="es" startAngle={Math.PI / 2} endAngle={0} centerOffset={[-0.5, 0, -0.5]} />);
            curveHandled = true;
        } else if (remaining === (DIR.S | DIR.W)) {
            parts.push(<CurveRailPart key="sw" startAngle={0} endAngle={-Math.PI / 2} centerOffset={[0.5, 0, -0.5]} />);
            curveHandled = true;
        } else if (remaining === (DIR.W | DIR.N)) {
            parts.push(<CurveRailPart key="wn" startAngle={-Math.PI / 2} endAngle={-Math.PI} centerOffset={[0.5, 0, 0.5]} />);
            curveHandled = true;
        }
    }

    // --- 3. それでも残った方向 (T字の枝、行き止まり、斜めの片割れなど) ---
    // 中心からその方向へ「ハーフ・レール」を伸ばす
    if (!curveHandled) {
        if (remaining & DIR.N) parts.push(<HalfRailPart key="h_n" length={0.5} rotation={0} offset={[0, 0, -0.25]} />);
        if (remaining & DIR.S) parts.push(<HalfRailPart key="h_s" length={0.5} rotation={0} offset={[0, 0, 0.25]} />);
        if (remaining & DIR.E) parts.push(<HalfRailPart key="h_e" length={0.5} rotation={Math.PI/2} offset={[0.25, 0, 0]} />);
        if (remaining & DIR.W) parts.push(<HalfRailPart key="h_w" length={0.5} rotation={Math.PI/2} offset={[-0.25, 0, 0]} />);
        
        // 斜めのハーフ（中心から角へ）
        const diagLen = Math.sqrt(2) / 2; // 約0.707
        if (remaining & DIR.NE) parts.push(<HalfRailPart key="h_ne" length={diagLen} rotation={-Math.PI/4} offset={[0.25, 0, -0.25]} />); // 位置調整が必要だが簡易的に
        if (remaining & DIR.SE) parts.push(<HalfRailPart key="h_se" length={diagLen} rotation={Math.PI/4} offset={[0.25, 0, 0.25]} />);
        if (remaining & DIR.SW) parts.push(<HalfRailPart key="h_sw" length={diagLen} rotation={-Math.PI/4} offset={[-0.25, 0, 0.25]} />);
        if (remaining & DIR.NW) parts.push(<HalfRailPart key="h_nw" length={diagLen} rotation={Math.PI/4} offset={[-0.25, 0, -0.25]} />);
    }

    return <group>{parts}</group>;

  }, [connections]);

  return (
    <group position={[position[0], railY, position[2]]}>
      {RailParts}
      {/* プレビュー時のハイライト */}
      {isPreview && (
         <mesh position={[0,0,0]}>
           <boxGeometry args={[0.9, 0.1, 0.9]} />
           <meshBasicMaterial color="#00aaff" transparent opacity={0.3} depthWrite={false} />
         </mesh>
      )}
    </group>
  );
};