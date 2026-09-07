# 指示書 P7 タスク11a-1(第 3 回。旧仕様を固定した既存テストの更新を包括的に承認): アセンブリの文書の実経路(model / io 側): 取り込み形状の鍵・橋の待機解除・文書の束と自動保存(レビュー R1-2・R1-4・R5-3。工数 L。ui 側の配線は 11a-2 が別に行う)

## 1. 目的と背景(コードで確認済み)

- **R1-2 取り込み形状のキャッシュ鍵**: `packages/model/src/part/cacheKey.ts:708-712` の `ImportedSolidKeyMaterial` は `kind: 'importedSolid'` と `shapeRef` だけ(`:1251` の鍵文字列 `importedSolid{shapeRef=…}`)。`shapeRef` は文書内の連番なので、**別々の STEP を取り込んだ 2 部品が同じ連番を持ち、1 つの Worker キャッシュを共用すると同じ B-rep を引き得る**(P7 で確実に問題になる)。単一文書の切替は `documentVersion` による消去で対処済み(rules/06 10.17)だが、同時に存在する複数文書の衝突は解けない。
- **R1-4 橋の待機登録**: `packages/model/src/kernelBridge.ts:2393-2413` の接続は `brokenSignal`(接続の寿命中ずっと同じ Promise)を持ち、`:2431-2438` の `raceWithBroken` は各 RPC ごとに `brokenSignal.then(...)` を登録して競争させる。**成功した RPC の競争相手に付けた反応は、破損シグナルが解決するまで解除されない**(P7 のドラッグや P8 の投影で高頻度に蓄積)。`:2459-2464` の終了は proxy の解放と `terminate()` を行うが、未決の RPC を明示的に決着させる契約が無い。
- **R5-3 文書の束**: `.pcada` はタスク 49(コミット待ち行列 1455)で部品ごとの添付を持てるようになった(`writePcadaFile(assembly, { partFiles, parts, partAttachments, … })` / `readPcadaFile(bytes)` → `result.parts` / `result.partAttachments` / `result.partAttachmentDigests`。`embedPart(library, document, fileName, path, { importedAt, attachments })`、`replacePartDocument(…)`。**read / write は非同期**)。一方 `packages/io/src/autoSave.ts` の `createAutoSaver`(:377)/ `AutoSaveRecord`(:29)は **PartDocument 専用**で、控えは `current` 1 件。P7 の別窓編集では各窓の自動保存が同じ current を上書きする。
- P7 計画 §0.a-0.63(11 → 11a / 11b)、タスク 11a の節(`docs/plans/P7-アセンブリ.md:1779`)、§2.2・§2.3。既決: 文書を nullable にしない、導出 B-rep は保存しない(取り込んだ B-rep は原本なので保存する)、新しい版は理由つきで拒否。

## 2. 変更の設計

1. **鍵(R1-2)**: `ImportedSolidKeyMaterial` に取り込みバイト列の**安定した内容ダイジェスト**(`shapeDigest`: 取り込み・読み込み時に 1 回だけ求めた SHA-256 の 16 進。毎回大きなバイト列をハッシュしない)を足す。鍵文字列は `importedSolid{shapeRef=…,digest=…}`。ダイジェストの置き場: `PcadAttachments` の shapes の各エントリに添える(io 側で読み込み時に計算して返す。タスク 49 の `partAttachmentDigests` と同じ流儀)か、model の `ImportedShape` 相当の型に持たせる。**古い文書(ダイジェスト無し)**は読み込み時に計算して補う(移行)。幾何的に同一な通常フィーチャーの共有は残す。
2. **橋(R1-4)**: 接続に `Set<() => void>` の待機通知を持たせ、RPC 開始時に登録、`finally` で解除、broken / dispose 時に全通知して集合を空にする。結果は `success / failed / cancelled / workerBroken` を識別できる形にする(既存の公開 API の戻り値の型を変えない範囲で。既存の `raceWithBroken` の目的「Worker が壊れたときに全操作が永遠に待たない」は維持)。Comlink の callback proxy の寿命もジョブ終了に合わせる。**検査用に待機登録数を読む口**(`bridge.pendingWaiters()` 等。統括の E2E と 11a-2 が使う)。
3. **文書の束(R5-3)**: 新規 `packages/model/src/assembly/documentBundle.ts` に `DocumentBundle = { kind: 'part' | 'assembly', document, attachments, embeddedDocuments? }` を定義し、`.pcada` の ZIP への平坦化(タスク 49 の `writePcadaFile` / `readPcadaFile`)だけを io が担当する形へ整理する(既存の関数は残し、束 ↔ ZIP の変換関数を足す)。
4. **自動保存**: `packages/io/src/autoSave.ts` を、束(`kind` + `documentId`(文書ごとの安定 ID)+ `sessionId`(窓ごと))で控えを分ける形へ拡張する。`RECORD_KEY` 1 件から「kind:documentId:sessionId」の鍵へ(既存の部品の控え = 既定の鍵、として**互換を保つ**: 古い控えが読める)。復元候補の一覧(`listRecords()`)を足す。書き込みは transaction の complete でのみ成功(R-2 の契約を保つ)。
5. ui 側(`attachAssembly.ts`、gateway、Undo、dirty、ビューポート)は **11a-2**。ここでは model / io の口と検査を閉じ、11a-2 が呼ぶ口の名前と引数を報告書に書く。

## 3. 編集所有ファイル / 読取専用

- 編集所有: `packages/model/src/part/cacheKey.ts`、`packages/model/src/part/cacheKey.test.ts`(実在を確認。無ければ該当テストへ)、取り込み形状の型を持つ model のファイル(`rg -n "importedSolid" packages/model/src --glob "*.ts" -l` で列挙して報告してから編集。`packages/model/src/part/recomputePart.ts` は読むだけ)、`packages/model/src/kernelBridge.ts`、`packages/model/src/kernelBridge.test.ts`、新規 `packages/model/src/assembly/documentBundle.ts`、新規 `packages/model/src/assembly/documentBundle.test.ts`、`packages/model/src/index.ts`(export だけ)、`packages/io/src/autoSave.ts`、`packages/io/src/autoSave.test.ts`、`packages/io/src/pcad/pcadFile.ts`(shapes のダイジェストを添える場合だけ)、`packages/io/src/pcad/pcadFile.test.ts`、`packages/io/src/index.ts`(export だけ)。
- 読取専用: `packages/model/src/assembly/partLibrary.ts`(タスク 49 の成果)、`packages/model/src/assembly/resolveAssembly.ts`・`types.ts`、`packages/kernel/src/worker/kernelApi.ts`・`shapeCache.ts`(他担当 タスク50 が編集中。**編集しない**)、`packages/ui/*`(11a-2)、`docs/plans/P7-アセンブリ.md`、`docs/reviews/2026-09-07-全体レビュー(gpt-6-astra).md` R1-2・R1-4・R5-3。
- 触らない: `packages/kernel/*`、`packages/ui/*`、`packages/io/src/pcad/assemblyJson.ts`(封筒の版は上げない)、`packages/io/src/pcad/readArchive.ts`。

## 4. 手順と中間報告(各段階の終わりに `progress.md` へ追記)

1. **現在値**: §1 の行番号・名前の一致を確認(`kernelBridge.ts` は R-5 の変更で行がずれている。関数名で確認)。`pnpm --filter @pointercad/model exec vitest run cacheKey kernelBridge` と `pnpm --filter @pointercad/io exec vitest run autoSave pcadFile` の件数。**再現 2 件**: ①同じ `shapeRef` で中身の違う取り込み形状 2 つが同じ鍵文字列になることをテストで示す。②RPC を N 回成功させた後の `brokenSignal` への登録数が N のまま残ることを(計測できる形で)示す。
2. **鍵**(設計 1)+ 移行 + テスト(2 文書 × 別 STEP を同一 Worker で交互に解決しても鍵が衝突しない。ダイジェストは読み込み時に 1 回だけ計算される)。
3. **橋**(設計 2)+ テスト(成功・失敗・dispose 後に待機登録数が 0。Worker 破損時に全 RPC が `workerBroken` で決着し永遠に待たない)。
4. **束と自動保存**(設計 3・4)+ テスト(部品と アセンブリの控えが別の鍵、古い控えが読める、`listRecords()`、transaction の complete でのみ成功)。
5. **検査**: `pnpm --filter @pointercad/model run test`、`pnpm --filter @pointercad/io run test`(全緑。件数)、`pnpm -w run typecheck`、`pnpm exec eslint <編集ファイル>`。性能(model の 100 段など `expectWithinBudget`)は予算内。

## 5. 合格条件(数値)

- 段階 1 の再現 2 件が修正後は解消(数値で)。新規テスト 10 件以上が緑。model・io のテストが全緑で件数が減っていない。
- 待機登録数が成功・失敗・dispose のそれぞれの後で 0(テストで示す)。
- typecheck 0(所有ファイル起因)、lint 0。封筒の版(8)・`parts/<ref>.json` の書式に差分が無い。公開 API の既存の戻り値の型に破壊的変更が無い(あれば止まって報告)。

## 6. 変更・緩和してはいけないもの

`packages/kernel/*`、`packages/ui/*`、封筒の版、`assemblyJson.ts`、既存テストの期待値、性能予算、`package.json`。

## 7. 関係する過去の失敗(rules/06)

10.17(単一文書の切替での鍵の衝突は `documentVersion` で対処済み。今回はその上で複数文書の衝突を鍵の内容で解く)、10.20(新規ファイルの export と参照先を報告に列挙)、10.11(共有ファイル: `kernelApi.ts` / `shapeCache.ts` はタスク50、ui は 11a-2)。

## 8. 使える道具

`rg`、`sed -n`、`pnpm --filter @pointercad/<pkg> exec vitest run <名前>`、`pnpm --filter @pointercad/<pkg> run test`、`pnpm -w run typecheck`、`pnpm exec eslint <ファイル>`。

## 9. 成果物

`__OUT__/report.md`(再現の数値、鍵の形、橋の待機の API、束と自動保存の鍵の形、テスト件数の前後、**11a-2 が呼ぶ口の名前と引数の一覧**)、`__OUT__/progress.md`。最終メッセージは要約 5 行 + 規律の 2 行。

## 10. 第 1 回からの申し送り(統括の回答)

第 1 回の担当は「新しい鍵文字列 `importedSolid{shapeRef=…,digest=…}` と、旧仕様を厳密に固定した既存テスト `packages/model/src/part/cacheKey.test.ts:1803-1806`(「鍵の文字列は入れ物の名前だけを持つ」)が衝突する」と見つけて編集前に停止した(正しい対応)。**統括の決定: 推奨案を採用。** その 1 件に限り、テスト名・入力フィクスチャ(`:411-413` の補助関数にダイジェストを足す)・厳密な期待値を新仕様 `importedSolid{shapeRef=shape-1,digest=<既知の SHA-256>}` に置き換えてよい(共通規律 6 の例外として明文化した。report.md に列挙する)。ダイジェスト無しの互換入口は**作らない**(`shapeRef` だけで鍵を作る公開入口を残さない)。

第 1 回が確認した現在値はそのまま使ってよい: `cacheKey.ts:708` / `:1251`、`resolvePart.ts:4047`(`planImportedSolid` が添付表から bytes を取る)/ `:4600`(鍵材料へ shapeRef だけ)/ `:5053`(`ImportedShapeBytes`)、`kernelBridge.ts:2401` `brokenSignal` / `:2439` `raceWithBroken` / `:2463` `closeKernelConnection`、`autoSave.ts:29` / `:377`、タスク 49 の非同期 API、`PcadAttachments = EmbeddedPartAttachments`。取り込み形状の型を持つのは `part/types.ts` と `part/resolvePart.ts`(編集所有に含める。`resolvePart.ts` は `:4600` 付近で鍵材料にダイジェストを渡す変更だけ)。着手前検査: model 172 件・io 113 件緑。**段階 2 から始める。**

## 11. 第 2 回からの申し送り(統括の回答)

第 2 回の担当は、所有外の `packages/model/src/part/resolvePart.test.ts:7184-7195`(「鍵は shapeRef だけで決まる」)も旧仕様を固定していると見つけて停止した(正しい対応)。**統括の決定: 推奨案 1。** `resolvePart.test.ts` を編集所有に加え、当該 1 件の名前・説明・入力・厳密な期待値を新仕様(同じ shapeRef・同じ内容なら同じ鍵、同じ shapeRef でも内容が違えば違う鍵、shapeRef が違えば違う鍵)へ更新してよい。**さらに包括的に**: `rg -n "importedSolid\{shapeRef=" packages/model/src --glob "*.test.ts"` や「shapeRef だけ」を前提にした他の既存テストが見つかった場合も、**同じ扱い**(その 1 件を新仕様の厳密な値へ更新し、report.md に列挙)で進めてよい。これ以上この理由では止まらない。段階 2 から始める。
