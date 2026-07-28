# OpenTTD風の段丘状標高地形

## Decision
- 標高はセーブ形式に含めず、既存の`terrain: Map<string,'water'|'mountain'>`から`computeElevation`で毎回決定的に導出する方式にした。永続化フォーマットを変えずに済み、mountain判定の意味(トンネル建設対象など)も不変。
- 標高値 = mountainセルから最も近い非mountainセルまでのマンハッタン距離を多始点BFSで計算し、`MOUNTAIN_ELEVATION_MAX=3`でクランプ。O(セル数)。
- 1段の高さは`sim/trackPath.ts`の`OVERPASS_HEIGHT(0.8)`に合わせた。将来の高架・トンネルとの視覚整合のため。
- 山脈生成の幅を`MOUNTAIN_WIDTH_MIN=3〜MAX=6`に拡張(旧1〜2)。標高2〜3の芯ができる幅を確保。
- 描画(`TerrainBlocks.tsx`)は「側面=BoxGeometryの柱(既存rock/rockDark流用)」+「上面=薄い板(標高1〜2は`grassTerrace`、標高3は`rockSnow`)」の2ジオメトリ重ねに刷新。旧・八面体の岩塊装飾(OctahedronGeometry)は廃止。

## Alternatives considered
- 標高をセーブデータに直接持たせる案 → 却下。既存セーブとの互換性を壊し、mountain判定と標高の二重管理になる。
- 3x3塊の中心標高を距離1にする単純化 → 実装時に誤りと判明(実際のBFSでは中心は距離2)。テストを実際のマンハッタン距離ベースの値に修正。

## Constraints / Gotchas
- BFSは「非mountainに隣接するmountainセル」を境界(距離1)として初期化し、そこから多段階に伝播する。距離がMAXを超えても訪問は続け、値だけクランプする(そうしないと芯の far セルが未訪問=標高0のままになるバグを踏む)。
- `tunnelKeys`(トンネル化済みセル)は従来通り描画をスキップする挙動を維持。標高の刷新後もこの分岐は変更していない。
- `MATERIALS.rockSnow`と`MATERIALS.grassTerrace`を`render/palette.ts`に新設。既存の`PALETTE.rockSnow`/`PALETTE.grassDark`を流用。
