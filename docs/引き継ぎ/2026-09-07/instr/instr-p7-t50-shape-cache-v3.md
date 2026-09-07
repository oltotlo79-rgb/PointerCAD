# 指示書 P7 タスク50(第 3 回。件数の参考値を更新): 使用中の形を shape cache の追い出しから守る(レビュー R1-3。kernel。工数 L)

## 1. 目的と背景(コードで確認済み)

- `packages/kernel/src/worker/shapeCache.ts` は件数 LRU(`SHAPE_CACHE_CAPACITY = 256` :70。理由の注記 :60-69)で、`set` が容量を超えると `dropOldest()` で**即時解放**(:130-139)。`delete` / `retain(liveKeys)` / `clear` がある(:143-170)。`packages/kernel/src/worker/kernelApi.ts:429` が `createShapeCache<CachedSolid>()` で 1 つ作り、`recomputeSolids.ts` が履歴の段ごとに `cache.get(step.key)` / `cache.set(step.key, entry)`。書き出し・点検・測定の入口 `resolveExportShapes`(`kernelApi.ts:117`)は**キャッシュに形があることを要求**し、無ければ `MISSING_BODY_MESSAGE` で投げる。
- P7 で 50 個の異なる部品に履歴があると、先に作った部品の**最終形状**まで追い出され得る。表示メッシュが残っていても測定・干渉・STEP・HLR が失敗する。容量を無制限に上げると WASM の上限(〜4 GB)へ近づく。**中間履歴の LRU と「いま使っている形(現在の作業集合)」の寿命は別**。
- 要件 NFR-PF-3(200 フィーチャー / 部品、50 部品)。P7 §2.13 の 50 部品の性能を測る前に必要。既存の容量 256 の数値は実測なしに変えない。

## 2. 変更の設計(レビューの具体策)

- `shapeCache.ts` に **使用中の保護** を足す: `acquire(keys: Iterable<string>): AcquireToken`(確保中の鍵は `dropOldest` の対象から外す)と `release(token)`(解放後は通常の LRU 対象へ戻る)。同じ鍵を複数の token が確保できる(参照カウント)。確保中の鍵だけで容量を超える場合は、超過を許して**診断に「保護対象だけで予算超過」を出す**(黙って追い出さない。処理の中止は呼び手が決める)。
- `kernelApi.ts`: ①各部品の**最終 body の鍵**は、次の再計算でその部品の最終 body が置き換わるまで確保する(部品ごとに 1 token を保持し、置き換え時に古い token を release)。②書き出し・点検・測定・(将来の)干渉・HLR など**複数の形を使う操作は、必要な鍵を先に確保してから実行**し、終わったら release(`resolveExportShapes` の前で確保。欠落があれば従来どおり `MISSING_BODY_MESSAGE`)。③進行中の再計算 job の入力の鍵も確保(job の終わりで release。取消・失敗・例外でも release されること)。
- **診断値**: `ShapeCacheStats`(:16)に「形の数・確保中の鍵の数・メッシュのバイト数(合計)」を足し、`kernelApi` の既存の統計の口(あれば)から読めるようにする。
- 欠落時の再取得(model が対象部品を再計算する経路)は **タスク 11a**(別担当)。ここでは「欠落を構造化して知らせる」まで。

## 3. 編集所有ファイル / 読取専用

- 編集所有: `packages/kernel/src/worker/shapeCache.ts`、`packages/kernel/src/worker/shapeCache.test.ts`、`packages/kernel/src/worker/kernelApi.ts`、`packages/kernel/src/worker/kernelApi.test.ts`、`packages/kernel/src/types.ts`(統計の型と、§10 の `partId` の追加)、`packages/model/src/kernelBridge.ts`(§10: `toSolidRecomputeRequest` と点検・書き出しの依頼に `partId` を通す配線だけ。他の関数は触らない)、`packages/model/src/kernelBridge.test.ts`(該当部分)、`packages/model/src/part/recomputePart.ts`(§10: `options.partId` を橋へ素通しするだけ)、`packages/kernel/src/worker/determinism.test.ts`(付録 T-1)、新規のヘルパー 1 ファイル(付録 T-1)。
- 読取専用: `packages/kernel/src/worker/recomputeSolids.ts`(`cache.get/set` の使い方の確認。**編集しない**。確保の呼び出しは kernelApi 側の job の入口で行う。どうしても要るなら止まって報告)、`packages/ui/*`(変えない。`partId` は省略時の既定で動く)、`docs/plans/P7-アセンブリ.md` の「タスク50」の節、`docs/reviews/2026-09-07-全体レビュー(gpt-6-astra).md` R1-3。
- 触らない: `packages/kernel/src/occt/*`(他担当 R-6 が `tessellate.ts` / `exportMesh.ts` を編集中)、model、ui、io。

## 4. 手順と中間報告(各段階の終わりに `progress.md` へ追記)

0. **段階 0(先に片づける小さな修正 T-1)**: `kernelApi.test.ts:1372` 付近(`:1387` の `toEqual`)の「面の色を渡さない依頼は、STEP でも glb でも配線を足す前とバイト列が変わらない」は同じ形を 2 回 STEP に書き出して全バイトを比べるため、書き出し時刻(FILE_NAME の秒)をまたぐと落ちる(14:24 の待ち行列で実際に 1 回落ちた)。`determinism.test.ts:373-417` と同じ規則で時刻の行を除いて比べる形に直す(ヘルパーを共通化してよい。期待の強さは変えない: 時刻以外の 1 バイトの差は検出する)。詳細は末尾の付録 T-1。

1. **現在値**: §1 の行番号・名前の一致を確認。`pnpm --filter @pointercad/kernel exec vitest run shapeCache kernelApi` の件数。**再現**: 容量 256 を超える数の段を持つ 2 部品(または小さな容量を注入したキャッシュ)で、先に作った部品の最終 body が追い出され `resolveExportShapes` が `MISSING_BODY_MESSAGE` になることを数値(鍵の数・追い出された鍵)で示す。
2. **shapeCache** の acquire / release / 診断。単体テスト: 確保中は追い出されない、release 後は追い出される、参照カウント、保護対象だけで超過したときの診断、`retain` / `clear` との整合(確保中でも `clear` は全解放してよいか = 呼び手が job を終えてから呼ぶ前提で、確保が残っていれば診断に出す)。
3. **kernelApi** の配線(最終 body の確保、複数形操作の確保、job の入力の確保と例外時の release)。
4. **テスト**: 段階 1 の再現が修正後は成功する(先に作った部品の最終 body が測定・書き出しから取得できる)。50 個の異種部品(小さな箱に 1 段ずつでよい)で最終 body 50 個が全部取得できる。取消・失敗した job の後で確保が残らない(確保中の鍵の数が 0 に戻る)。
5. **検査**: `pnpm --filter @pointercad/kernel run test`(全緑。件数)、性能テスト(`solidPerformance.test.ts` の 100 段など)が予算内、`pnpm -w run typecheck`、`pnpm exec eslint <編集ファイル>`。

## 5. 合格条件(数値)

- §4-2・4 の新規テスト 8 件以上が緑。kernel のテストが全緑で件数が減っていない。性能予算内(100 段の値を前後で報告)。
- `SHAPE_CACHE_CAPACITY` の値に差分が無い。typecheck 0(所有ファイル起因)、lint 0。`recomputeSolids.ts` に差分が無い。
- 確保中の鍵の数が、操作の前後で 0 → N → 0 と戻ることをテストで示す。

## 6. 変更・緩和してはいけないもの

容量 256、性能予算、`recomputeSolids.ts`、`kernelBridge.ts` の公開の口、`packages/kernel/src/occt/*`、既存テストの期待値。

## 7. 関係する過去の失敗(rules/06)

10.13(embind の所有権: 確保は「解放しない」印であって所有の移動ではない。解放は従来どおり cache が行う)、10.16(貸した形を変異させない)、10.11(共有ファイル: `types.ts` は統計の型の追加だけ。`kernelApi.ts` は待ち行列 1440(R-5)の着地後に編集を始める — 統括が着地を確認してから起動する)。

## 8. 使える道具

`rg`、`sed -n`、`pnpm --filter @pointercad/kernel exec vitest run <名前>`、`pnpm --filter @pointercad/kernel run test`、`pnpm -w run typecheck`、`pnpm exec eslint <ファイル>`。

## 9. 成果物

`__OUT__/report.md`(再現の数値、API の形、テスト件数の前後、性能の前後、11a への申し送り(欠落の知らせ方と再取得の口))、`__OUT__/progress.md`。最終メッセージは要約 5 行 + 規律の 2 行。


## 10. 第 1 回からの申し送り(統括の回答: 選択肢 1 を採用)

第 1 回の担当は「再計算の依頼(`SolidRecomputeRequest`、`packages/kernel/src/types.ts:454`)に部品の識別子が無く、部品ごとの token の更新方法が未定義」と見つけて編集前に停止した(正しい対応)。**統括の決定: 選択肢 1。** 文書 / session 内で安定した部品の識別子 `partId: string` を依頼へ明示し、token と表示メッシュ(R-5 が足した保持。いまは窓口全体で 1 世代・毎回全置換)を **partId ごと**に分ける。具体的には:

- `types.ts`: `SolidRecomputeRequest` と、点検・書き出し・測定など複数の形を使う依頼の型に `readonly partId?: string` を足す(省略時の既定は `'part:current'`。単体の部品文書はこれで動くので **ui は変えない**)。
- `kernelBridge.ts:2030` 付近の `toSolidRecomputeRequest` と呼び出し元(:2517・:2728 付近)は `options.partId` を素通し(`recomputePart.ts` の options にも `partId?: string` を足して素通し)。11a-1 / 11a-2 が部品ごとに `partRef` を渡す。
- `kernelApi.ts`: partId → 最終 body の token(置き換え時に古い token を release)、partId → 表示メッシュの世代と保持(別の部品の再計算で他の部品の表示メッシュを消さない)。点検・書き出しは依頼の partId の表示メッシュ / 形を使う。partId が消えた部品(11a が知らせる)の token を release する口 `releasePart(partId)` を足す。
- フィーチャー id・先頭の鍵・generation から部品を推測する方式は採らない(第 1 回の判断どおり)。

第 1 回の確認済みの現在値(`SolidRecomputeRequest` の 4 項目、`kernelApi.ts:479` の入口、:430-432 / :496 の表示メッシュ管理、:295 の点検対象)はそのまま使ってよい。**段階 0(T-1)から始める。**

---

# 付録 T-1(段階 0 の詳細。編集所有に `packages/kernel/src/worker/determinism.test.ts` と新規のヘルパー 1 ファイルを追加する)

# 指示書 T-1: 時刻に依存して落ちる kernel のテストを、時刻の行を除いて比べる形に直す(テストの欠陥の修正。期待値は緩めない)

## 1. 目的と背景(統括が待ち行列の検査ログで確認)

- `packages/kernel/src/worker/kernelApi.test.ts:1367` 付近のテスト「面の色を渡さない依頼は、STEP でも glb でも配線を足す前とバイト列が変わらない(回帰なし)」は、**同じ形を 2 回 STEP に書き出して `expect(stepWithEmpty.bytes).toEqual(stepWithout.bytes)` で全バイトを比べる**。
- STEP のテキストには `FILE_NAME(..., '2026-09-07T14:17:22', ...)` のような**書き出した時刻**が入る。2 回の書き出しの間に秒が変わると 15,766 バイトのうち時刻の桁だけが違い、テストが落ちる。機械が混んでいるほど 2 回の間隔が延びて落ちやすい(2026-09-07 14:24 の待ち行列 1410 の検査で 1 回落ちた。同じコードで 14:16 の検査は通っている)。
- 既存の `packages/kernel/src/worker/determinism.test.ts:373-417` は STEP の時刻の行を検証して**除外してから**比べている(正しい流儀)。同じ方法をこのテストに適用する。

## 2. 変更の内容

- `kernelApi.test.ts` の当該テストで、STEP のバイト列を比べる前に `determinism.test.ts` と同じ規則で時刻の行(`FILE_NAME` の日時)を正規化する。`determinism.test.ts` に再利用できる関数があれば、それを **同じファイル内にコピーせず**、共通の場所(`packages/kernel/src/worker/` のテスト用ヘルパー。既存の慣習に合わせて命名。無ければ新規 `stepTextForComparison.ts` のような小さなファイル。ビルドに混ざらない置き方を確認)へ移して両方から使う。
- **期待の強さは変えない**: 時刻以外の全バイトが一致することを引き続き求める。時刻の行が「日時の形式(ISO 8601)である」ことも確かめる。glb 側の比較は時刻を含まないので変えない。

## 3. 編集所有ファイル / 読取専用

- 編集所有: `packages/kernel/src/worker/kernelApi.test.ts`(当該テストと import だけ)、`packages/kernel/src/worker/determinism.test.ts`(ヘルパーを共通化する場合の import 置き換えだけ)、新規のヘルパー 1 ファイル(必要なら)。
- 読取専用: `packages/kernel/src/occt/writeStep.ts`(時刻をどう書くか)、`docs/報告記録.md`。
- 触らない: 製品コード全部、他のテスト、性能予算。

## 4. 手順と中間報告

1. **現在値**: 当該テストの行と、`determinism.test.ts` の除外の実装を報告。`pnpm --filter @pointercad/kernel exec vitest run kernelApi` の件数(**60 件**。R-5 の着地 `5eb3db8` で 58 → 60。第 2 回の実測 kernelApi 60・shapeCache 19、10.82 秒)。
2. 変更。
3. **再現の確認**: 2 回の書き出しの間に秒が変わる状況を作って(テスト内で `Date` を偽装するか、時刻の行を意図的に別の秒にした写しを比べる)、修正前なら落ち、修正後は通ることを示す。
4. **検査**: `pnpm --filter @pointercad/kernel exec vitest run kernelApi determinism`(全緑。件数)、`pnpm -w run typecheck`、`pnpm exec eslint <編集ファイル>`。

## 5. 合格条件(数値)

- kernel の当該 2 ファイルのテストが全緑で件数が減っていない。typecheck 0、lint 0。
- 時刻以外のバイトの差を検出する力が残っている(時刻以外の 1 バイトを変えた写しで落ちることを 1 件のテストで示す)。

## 6. 変更してはいけないもの

製品コード、`writeStep.ts`、他のテストの期待値、時刻の行以外の比較。

## 7. 関係する過去の失敗(rules/06)

10.12・10.14(共有ランナー・CPU 競合で落ちる検査 → 時刻や速度に依存しない検査にする)。

## 8. 使える道具

`rg`、`sed -n`、`pnpm --filter @pointercad/kernel exec vitest run <名前>`、`pnpm -w run typecheck`、`pnpm exec eslint <ファイル>`。

## 9. 成果物

`__OUT__/report.md`(変更点、再現の証拠、件数の前後)、`__OUT__/progress.md`。最終メッセージは要約 3 行 + 規律の 2 行。

## 11. 第 2 回からの申し送り(統括の回答)

第 2 回の担当は「kernelApi のテスト件数が指示の 58 件でなく 60 件」で停止した。**これは参考値のずれであり、止まる理由ではない**(共通規律 7 を補足した: 行番号・件数・注記のずれは実測値を書いて続行する)。基準件数は **60 件**。第 2 回が確認した現在値(`ShapeCacheStats` の 3 欄、容量 256、`resolveExportShapes` の欠落時の投げ方、`kernelApi.ts:430-432` / `:496` の表示メッシュ管理、`:479` の入口、T-1 の対象テスト `:1372-1387`)はそのまま使ってよい。**段階 0(T-1)から実装を始める。次に止まってよいのは §10 の設計に矛盾が見つかったときだけ。**
