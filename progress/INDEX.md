# progress インデックス

- [economy-and-passenger-demand.md](economy-and-passenger-demand.md) — 所持金/建設コスト/列車購入の課金ロジック(no-op判定の使い方と限界)、旅客需要(waiting)・乗降・運賃収入(income)のsim層実装、セーブデータv2移行
- [construction-layer-and-bugfixes.md](construction-layer-and-bugfixes.md) — 建設ロジックを sim/construction.ts へ純粋関数化し、既知バグ5件（上書き防止・斜め線路駅・駅名採番・モード切替直後クリック）をTDDで修正
- [clock-and-persistence.md](clock-and-persistence.md) — ゲーム内時計(0/1/2/4x)とlocalStorageセーブ/ロードの設計。runtimes Mapはインスタンス維持で入れ替えること
- [sim-layer-extraction.md](sim-layer-extraction.md) — 走行ロジックを純粋なsim層(stepWorld)へ分離した経緯と、非表示タブのrAF停止・既知バグ一覧などの注意点
