# progress インデックス

- [construction-layer-and-bugfixes.md](construction-layer-and-bugfixes.md) — 建設ロジックを sim/construction.ts へ純粋関数化し、既知バグ5件（上書き防止・斜め線路駅・駅名採番・モード切替直後クリック）をTDDで修正
- [clock-and-persistence.md](clock-and-persistence.md) — ゲーム内時計(0/1/2/4x)とlocalStorageセーブ/ロードの設計。runtimes Mapはインスタンス維持で入れ替えること
- [sim-layer-extraction.md](sim-layer-extraction.md) — 走行ロジックを純粋なsim層(stepWorld)へ分離した経緯と、非表示タブのrAF停止・既知バグ一覧などの注意点
