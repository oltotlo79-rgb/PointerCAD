# 指示書 R-3(第 2 回。型定義のパスを訂正): ブーリアンを非破壊モードで始め、例外経路でも解放する(レビュー 2026-09-07 R2-2、重大度 高、工数 M〜L)

## 1. 目的と背景(コードで確認済み)

- `packages/kernel/src/occt/booleanOp.ts:57-63` の `createBooleanMaker` は入力 2 形状を取るコンストラクタ `BRepAlgoAPI_Fuse_3 / Cut_3 / Common_3(target, tool, range)` を使う。`:79-149` は `HasErrors()` / `IsDone()`、solid 化、体積、妥当性を確かめるが、後段の `Shape()`・測定・妥当性検査**自身が OCCT 例外を投げた**場合の builder / shape の解放は、明示的な不成立分岐と同じようには覆っていない。
- OCCT の Boolean は、更新が必要な下位形状(許容値・pcurve)を**入力側に書き戻す**ことがある。入力はキャッシュ上の形(他のフィーチャーと共有)なので、貸した形を変異させると rules/06 10.16(P5 のロフトで借用面が壊れた)の再発になる。
- OCCT の `BRepAlgoAPI_BuilderAlgo` 系には `SetNonDestructive(Standard_True)` があり、変更が要る下位形状を複製してから計算する。ただし**計算後に立てても遅い**ので、空の builder を作り → `SetArguments` / `SetTools` → `SetNonDestructive(true)` → `Build(range)` の経路が要る。この経路が固定 WASM(opencascade.js 2.0.0-beta.b5ff984、`packages/kernel/node_modules/opencascade.js/dist/opencascade.full.d.ts`(リポジトリ直下の node_modules には無い。第 1 回の担当が実在を確認済み))で呼べるかは**あなたが実証する**。

## 2. 変更の設計(レビューの具体策)

- 実証で経路が使えるなら: 空 builder(`BRepAlgoAPI_Fuse_1()` 等の引数なしコンストラクタ)+ `TopTools_ListOfShape` に入力を積む + `SetArguments` / `SetTools` + `SetNonDestructive(true)` + `Build(range)` へ変える。3 演算(union / subtract / intersect)すべて。
- 使えない(型定義に無い・実行時に無い)場合だけ: 入力を `BRepBuilderAPI_Copy_2(shape, true, false)` で複製して渡す(複製は必ず解放する)。どちらを採ったか、根拠(d.ts の行・実行時の結果)を報告に書く。
- `createAllocations`(`packages/kernel/src/occt/allocations.ts`、読取専用)で**すべての例外経路**を覆い、返す形へ必要な所有だけを移す。builder・中間の shape・体積計測の一時物が例外時にも解放されること。
- 「貸した入力を、失敗した後も別の加工でそのまま使える」回帰テストを必須にする。

## 3. 編集所有ファイル / 読取専用の依存

- 編集所有: `packages/kernel/src/occt/booleanOp.ts`、その単体テスト(`rg -l "booleanOp" packages/kernel/src --glob "*.test.ts"` で見つかる既存のテスト。無ければ新規 `packages/kernel/src/occt/booleanOp.test.ts`)。
- 読取専用: `packages/kernel/src/occt/allocations.ts`、`packages/kernel/src/occt/makeThruSections.ts`(10.16 の対処例: 深い Copy)、`packages/kernel/src/worker/recomputeSolids.ts`(呼び出し元。編集しない)、`packages/kernel/src/worker/shapeCache.ts`、`packages/kernel/node_modules/opencascade.js/dist/opencascade.full.d.ts`(リポジトリ直下の node_modules には無い。第 1 回の担当が実在を確認済み)(型定義。編集しない)、`rules/06-過去の失敗と対策.md` 10.13・10.16、`packages/test-utils/src/*`(性能予算の道具)。
- 触らない: kernel の他のファイル、`packages/model/*`、性能予算の数値。

## 4. 手順と中間報告(各段階の終わりに `progress.md` へ追記)

1. **現在値**: §1 の行番号・関数名の一致を確認。kernel のテスト全体を 1 回走らせ(`pnpm --filter @pointercad/kernel run test`)、件数・時間と、ブーリアンを含む性能テストの実測値(例: 「ブーリアン 99 段」「穴 20 個の板」など、テスト名と ms)を記録する。他担当が並行して検査を走らせているので値が荒れる。**2 回**測って両方を書く。
2. **API の実証**: d.ts で `BRepAlgoAPI_Fuse_1` / `Cut_1` / `Common_1`(引数なし)、`SetArguments` / `SetTools`(`TopTools_ListOfShape`)、`SetNonDestructive`、`Build`、`TopTools_ListOfShape` のコンストラクタと `Append` の有無と正確な overload 名を確認して報告。小さな箱 2 個で実際に呼び、成功と(意図的に失敗する入力での)失敗の両方で例外・解放を確認する。
3. **実装**(§2)。既存の成否判定(HasErrors / IsDone / solid 化 / 体積 / 妥当性)と日本語の失敗理由は保つ。
4. **回帰テスト**: ①A∪B の後に A−C、さらに A∩D を**同じ A のインスタンス**で行い、A を新しく作り直した場合と体積(1e-6 mm³ 相対)・面数・辺数が一致する。②失敗する Boolean(退化した工具など既存テストで使っている失敗例)の後に同じ入力で成功する演算を行い結果が正しい。③例外経路で解放漏れが無いこと(`createAllocations` の解放件数など、既存の検査手段があればそれで。無ければ「例外時に delete が呼ばれる」ことをモックか計数で確かめる)。
5. **性能**: 段階 1 と同じ性能テストを 2 回測り、前後を表にする。**予算(`expectWithinBudget` の値)は変えない。** 非破壊モードで予算を超えるなら、実装を戻さずに数値と原因の見立て(複製の量など)を報告して止まる(統括が判断する)。
6. **検査**: `pnpm --filter @pointercad/kernel run test`(全緑。件数)、`pnpm -w run typecheck`、`pnpm exec eslint packages/kernel/src/occt/booleanOp.ts <テスト>`。

## 5. 合格条件(数値)

- §4-4 の回帰テスト 3 件が全緑。kernel のテストが全緑で件数が減っていない。
- 性能テストが着手前と同じ予算内(非厳密モードでの参考値でよいが、前後の ms を表で報告)。
- typecheck 0(所有ファイル起因)、lint 0。
- `rg "Fuse_3|Cut_3|Common_3" packages/kernel/src/occt/booleanOp.ts` が 0 行(非破壊経路を採った場合)。Copy 経路を採った場合は複製の解放が全経路にあること。

## 6. 変更・緩和してはいけないもの

性能予算、既存テストの期待値、`recomputeSolids.ts` などの呼び出し元、失敗理由の日本語、`package.json` / WASM の版、`allocations.ts`。

## 7. 関係する過去の失敗(rules/06)

10.13(embind の持ち主を見分けられず二重解放・解放漏れ)、10.16(キャッシュ上の立体から借りた面を builder に渡して貸した立体を壊した → 深い Copy で対処。今回はその Boolean 版)、10.3(並列の検査中に性能検査が CPU 競合で落ちた → 2 回測る。予算は緩めない)。

## 8. 使える道具

`rg`、`sed -n`、`pnpm --filter @pointercad/kernel exec vitest run <名前>`、`pnpm --filter @pointercad/kernel run test`、`pnpm -w run typecheck`、`pnpm exec eslint <ファイル>`。OCCT の資料(`dev.opencascade.org` の refman)は参照してよいが、固定 WASM での可否は d.ts と実行で確かめる。

## 9. 成果物

`__OUT__/report.md`(採った経路と根拠、API の実証結果(overload 名・可否)、テスト件数の前後、性能の前後表(2 回ずつ)、統括への依頼)、`__OUT__/progress.md`。最終メッセージは要約 5 行 + 規律の 2 行。

## 10. 第 1 回からの申し送り

第 1 回の担当は「型定義の指定パスが実在しない」ことを見つけて編集前に停止した(正しい対応)。訂正済み: 型定義は `packages/kernel/node_modules/opencascade.js/dist/opencascade.full.d.ts`。他の前提(行番号・関数名)は一致していると確認された。既存テスト `packages/kernel/src/occt/booleanOp.test.ts` が実在する(第 1 回の報告)。段階 1 から始めてよい。
