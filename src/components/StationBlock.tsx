import React from 'react';
import type { PlatformDoorType } from '../types';
import { materialsFor, PALETTE, angleFromVector } from '../render/palette';
import { BOUNDARY_OFFSETS } from '../render/trackGeometry';

interface Props {
  position: [number, number, number];
  connections?: number;
  platformDoors: PlatformDoorType;
  /** ホームのどちら端か。端のセルだけ上屋の妻面(端の柱)を立てる。 */
  isEnd?: boolean;
  /** P8b: 地下ビュー中、選択中の地下レベル以外の駅は暗く半透明にする。 */
  dimmed?: boolean;
}

// --- 寸法(1セル=1.0、線路の軌道中心が原点) ---
const PLATFORM_HEIGHT = 0.19;   // ホーム面の高さ(レール上面0.13より少し高い)
const PLATFORM_INNER = 0.22;    // 軌道中心からホーム端までの距離
const PLATFORM_OUTER = 0.5;     // セル境界まで
const PLATFORM_WIDTH = PLATFORM_OUTER - PLATFORM_INNER;
const PLATFORM_CENTRE = (PLATFORM_INNER + PLATFORM_OUTER) / 2;
const TACTILE_WIDTH = 0.06;
const CANOPY_HEIGHT = 0.72;
// 上屋の幅。ホーム幅より狭くして軌道側を開けておく。
const CANOPY_WIDTH = 0.2;
const PILLAR_RADIUS = 0.022;

/**
 * 線路の接続方向からホームの向き(軌道の軸)を求める。
 * ローカル +Z が軌道方向、ローカル ±X がホーム側になる。
 */
export const trackAngleFromConnections = (connections = 0): number => {
  for (const o of BOUNDARY_OFFSETS) {
    if (connections & o.bit) {
      const len = Math.sqrt(o.x * o.x + o.z * o.z) || 1;
      return angleFromVector(o.x / len, o.z / len);
    }
  }
  return angleFromVector(0, 1); // 接続なし(建設直後など)は南北向き
};

/** ホーム片側ぶん(床・側面・点字ブロック・上屋・ホームドア)。side=+1/-1 */
const PlatformSide: React.FC<{ side: 1 | -1; doors: PlatformDoorType; isEnd: boolean; dimmed: boolean }> = ({
  side, doors, isEnd, dimmed,
}) => {
  const MATERIALS = materialsFor(dimmed);
  const cx = side * PLATFORM_CENTRE;
  const edgeX = side * (PLATFORM_INNER + TACTILE_WIDTH / 2);
  const doorHeight = doors === 'fullscreen' ? CANOPY_HEIGHT - PLATFORM_HEIGHT : 0.17;
  const doorX = side * PLATFORM_INNER;

  // ホーム設備(床・柱・上屋・ホームドアなど)は選択対象ではない。駅の選択は
  // 地面プレーンのクリック位置(セル座標)から判定しているため、これらのメッシュが
  // レイキャストを受け取ると真下の地面(および高架下の地平セル)がクリックできなく
  // なる。raycast={() => null}で常に素通しにする。
  const noRaycast = () => null;

  return (
    <group>
      {/* ホーム床 */}
      <mesh position={[cx, PLATFORM_HEIGHT / 2, 0]} receiveShadow castShadow material={MATERIALS.platform} raycast={noRaycast}>
        <boxGeometry args={[PLATFORM_WIDTH, PLATFORM_HEIGHT, 1.0]} />
      </mesh>
      {/* 軌道側の側壁(床とわずかに色を変えて厚みを見せる) */}
      <mesh position={[side * (PLATFORM_INNER + 0.012), PLATFORM_HEIGHT / 2 - 0.01, 0]} material={MATERIALS.platformSide} raycast={noRaycast}>
        <boxGeometry args={[0.024, PLATFORM_HEIGHT - 0.02, 1.0]} />
      </mesh>
      {/* 点字ブロック(黄色い警戒線) */}
      <mesh position={[edgeX, PLATFORM_HEIGHT + 0.005, 0]} material={MATERIALS.tactile} raycast={noRaycast}>
        <boxGeometry args={[TACTILE_WIDTH, 0.012, 1.0]} />
      </mesh>

      {/* 上屋。ホームの外寄りだけを覆う細い庇にして、軌道側(点字ブロック・停車中の
          列車)が真上から見ても隠れないようにする。 */}
      <mesh position={[side * (PLATFORM_OUTER - CANOPY_WIDTH / 2 + 0.02), CANOPY_HEIGHT, 0]} castShadow material={MATERIALS.canopyRoof} raycast={noRaycast}>
        <boxGeometry args={[CANOPY_WIDTH, 0.032, 1.0]} />
      </mesh>
      {/* 柱(セル境界に立てるので、連続したホームでは等間隔に並んで見える) */}
      {(isEnd ? [-0.45, 0.45] : [0.45]).map((z, i) => (
        <mesh
          key={i}
          position={[side * (PLATFORM_OUTER - 0.06), (CANOPY_HEIGHT + PLATFORM_HEIGHT) / 2, z]}
          material={MATERIALS.canopyPillar}
          raycast={noRaycast}
        >
          <cylinderGeometry args={[PILLAR_RADIUS, PILLAR_RADIUS, CANOPY_HEIGHT - PLATFORM_HEIGHT, 8]} />
        </mesh>
      ))}

      {/* ホームドア(標準=腰高、フルスクリーン=天井まで)。中央にドア開口を空ける */}
      {doors !== 'none' && [-0.32, 0.32].map((z, i) => (
        <group key={i} position={[doorX, PLATFORM_HEIGHT + doorHeight / 2, z]}>
          <mesh material={MATERIALS.platformDoor} raycast={noRaycast}>
            <boxGeometry args={[0.05, doorHeight, 0.34]} />
          </mesh>
          <mesh position={[side * 0.028, 0.01, 0]} material={MATERIALS.platformDoorGlass} raycast={noRaycast}>
            <boxGeometry args={[0.012, doorHeight * 0.62, 0.28]} />
          </mesh>
        </group>
      ))}
    </group>
  );
};

/**
 * 駅セル1つぶんの描画。
 *
 * 線路そのものは TrackNetwork がまとめて敷くので、ここではホーム設備だけを描く。
 * 軌道の向き(connections)に合わせて回転させるため、斜めの駅でもホームが線路に沿う。
 */
export const StationBlock: React.FC<Props> = ({
  position, connections, platformDoors, isEnd = false, dimmed = false,
}) => {
  const angle = trackAngleFromConnections(connections);
  return (
    <group position={position} rotation={[0, angle, 0]}>
      <PlatformSide side={1} doors={platformDoors} isEnd={isEnd} dimmed={dimmed} />
      <PlatformSide side={-1} doors={platformDoors} isEnd={isEnd} dimmed={dimmed} />
    </group>
  );
};

/** 駅の中心に置く小さな駅舎(1駅につき1つ)。 */
export const StationHouse: React.FC<{ position: [number, number, number]; angle: number }> = ({
  position, angle,
}) => (
  <group position={position} rotation={[0, angle, 0]}>
    {/* 本屋はホームの外側(+X方向)に寄せて置く。装飾であり選択対象ではないので、
        地面クリックを奪わないようレイキャストを外す。 */}
    <group position={[0.95, 0, 0]}>
      <mesh position={[0, 0.28, 0]} castShadow receiveShadow raycast={() => null}>
        <boxGeometry args={[0.7, 0.56, 0.9]} />
        <meshStandardMaterial color="#efe9df" roughness={0.9} />
      </mesh>
      {/* 寄棟屋根(4角錐) */}
      <mesh position={[0, 0.66, 0]} rotation={[0, Math.PI / 4, 0]} castShadow raycast={() => null}>
        <coneGeometry args={[0.66, 0.24, 4]} />
        <meshStandardMaterial color={PALETTE.buildingRoof} roughness={0.85} flatShading />
      </mesh>
      {/* 入口 */}
      <mesh position={[0.355, 0.18, 0]} raycast={() => null}>
        <boxGeometry args={[0.02, 0.3, 0.3]} />
        <meshStandardMaterial color="#3a4a55" roughness={0.4} />
      </mesh>
    </group>
  </group>
);
