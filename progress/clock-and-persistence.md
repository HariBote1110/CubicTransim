# ゲーム内時計とセーブ／ロード（フェーズ1後半）

## Decision
- 時計: `App` の `simSpeed`(0|1|2|4) を `SimulationDriver` に渡し `stepWorld(world, delta × simSpeed)`。0 は stepWorld を呼ばない。ロジックが dt 比例なのでこれだけで正しく動く。
- セーブ: `sim/persistence.ts` の `serialiseWorld`/`deserialiseWorld`（Map⇔配列変換のみ）。localStorage キー `cubictransim-save-v1`、`SaveData.version: 1` を持つ。
- ロード時、`worldRef.current.runtimes` は **Map インスタンスを維持したまま clear()→set** で入れ替える（DynamicTrain が Map 参照を保持しているため、差し替えると描画が古い runtime を見続ける）。

## Alternatives considered
- ファイルへの書き出し（JSON ダウンロード）→ まずは localStorage で十分。マップエディタ的な用途が出たら追加。

## Constraints / Gotchas
- セーブデータに TrainRuntime（走行中の位置・速度・経路）も含む。走行中にセーブ→ロードすると列車はその場から再開する。
- スキーマを変えるときは `version` を上げ、`deserialiseWorld` で旧版の移行処理を書くこと。
