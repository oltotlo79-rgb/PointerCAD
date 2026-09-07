# 指示書 P7 タスク11a-2(第 4 回。documentSlice.ts と Toolbar.tsx を所有に加えて共通の入口を完成させ、着地できる状態にする): アセンブリの文書の実経路(ui 側): attachAssembly・保存 / 開く・Undo・dirty・自動保存・ビューポートの実配線(レビュー R4-1・R6-1。工数 L)

## 1. 目的と背景(コードで確認済み)

- 11a-1(コミット 1480)が model / io の口を用意した(report「11a-2 が呼ぶ口」): `createPartDocumentBundle(document, attachments?)`、`createAssemblyDocumentBundle(document, library?)`、`partLibraryOfBundle(bundle)`、`createKernelBridge(): MonitoredKernelBridge`(`pendingWaiters()` / `pendingCallbacks()` / `operationCounts()` / `operationStatus(result)`)、io `writeDocumentBundle(bundle, { savedAt?, thumbnailPng? }): Promise<Uint8Array>`、`readDocumentBundle(bytes, kind, options?)` → `{ ok: true, bundle, savedAt, thumbnailPng? } | { ok: false, error }`、自動保存 `createAutoSaver({ storage, kind?, documentId?, sessionId?, … })`(`markDirty` / `saveNow` は `PartDocument | DocumentBundle`、`readLatest` / `discard(identity?)`、`listRecords()`、`stop()`)、`autoSaveRecordKey(identity)`。**文書を開く単位で saver を持ち、切替時は以前の saver を stop する。documentId は文書ごとの安定 ID、sessionId は窓の ID。**
- タスク49(`a728ef7`): `writePcadaFile` / `readPcadaFile`(非同期)、`embedPart(library, document, fileName, path, { importedAt, attachments })`、`replacePartDocument(…)`、`result.partAttachments` / `partAttachmentDigests`。タスク50(`692efea`): 依頼の `partId`(省略時 `'part:current'`。**アセンブリでは `partRef` を渡す**)、`releasePart(partId)`。R-1(`ea1fcf1`): `FileGateway` の `openPcad` → `saveTargetToken` → `confirmSaveTarget(token)` / `clearSaveTarget()`。R-2: 自動保存の失敗通知と復元できない控え。P7 52(`81e74de`): `requestedGeneration / completedGeneration / lastOutcome`。
- 現状の ui: `packages/ui/src/store/assemblySlice.ts`(`openAssembly` :49、種別判定)、`documentKind.ts`(`activeDocumentKind`、`activePartDocument` はアセンブリ中 null)、`packages/ui/src/viewport/ViewportCanvas.tsx:474-519`(library なし・空 body の仮配線)、`packages/ui/src/shell/AssemblyTree.tsx:205-215`(`openAssembly` で直接更新)、`packages/ui/src/store/attachKernel.ts`(part 前提の再計算)、`packages/ui/src/file/partFile.ts` / `fileGateway.ts`(part の開く / 保存)、`packages/ui/src/file/attachAutoSave.ts`(part の自動保存)。**アセンブリが見えていても保存・再計算・未保存確認が裏の part を対象にする経路がある**(R4-1)。
- 既決: 文書を nullable にしない(P7 §0.a-0.62)、同一部品は 1 回だけ再計算、別窓編集の約束(§0.a-0.3・0.4・0.11)。§0.a-0.63(11a / 11b の分割)。

## 2. 変更の設計(P7 タスク11a の節 + レビュー R4-1・R6-1)

1. 新規 `packages/ui/src/assembly/attachAssembly.ts`(+ test): アセンブリ文書の**実経路** = `PartLibrary` の保持 → 各部品の再計算(kernel bridge に `partId = partRef` で依頼。同じ部品は 1 回)→ `resolveAssembly({ …, resolvedParts })` → 配置つきの body 一覧(ビューポート用)。世代(generation)と取消(R-7b の shouldCancel の流儀)を持ち、古い結果を適用しない。欠落(タスク50 の構造化された知らせ)は対象部品を再計算して再取得。部品が消えたら `releasePart`。
2. **共通の入口**: ファイル / Undo / タイトル / dirty の判定を `activeDocumentKind` による**1 か所の分岐**にする(各機能に散った推測でなく)。既存の part の経路は変えない(`activePartDocument` が非 null のときは従来どおり)。
3. **保存 / 開く**: `.pcada` を `FileGateway` 経由で開く・保存する口を足す(R-1 の token の流儀と同じ: 読み込み成功と適用の後に `confirmSaveTarget`、新規・種別切替で `clearSaveTarget`)。Electron の IPC(`apps/desktop/src/main/pcadDialogs.ts`)は `.pcad` と `.pcada` のフィルタ以外は同じ経路(R-10 の `validateAppSender` を通す)。`writeDocumentBundle` / `readDocumentBundle` を使い、添付(部品ごとの shapes / meshes / canvases)を往復させる。
4. **Undo**: アセンブリの履歴操作(配置・固定・表示・抑制。タスク7 の `assemblyEdit.ts`)を履歴の単位にする。添付は Undo/Redo から参照されなくなるまで保つ(R3-4)。
5. **自動保存**: アセンブリの saver(`kind: 'assembly'`、documentId、sessionId)。part と別の控え。復元の案内は kind ごと。
6. **ビューポート**: `ViewportCanvas.tsx:474-519` の仮配線を実配線に(`createAssemblyLayer.ts` は共有形状 + Group の既存方式のまま。外観の優先順 = インスタンス上書き → 部品の面 / ボディ外観 → 既定(R4-2)。鏡・クリッピングは **11b / 26** の完了条件なので今回は触らない)。
7. **検査用の口**: `window.pcadRecomputeStats()` に `pendingWaiters` と `activeDocumentKind` を足す(E2E が使う)。
8. **文言**: `packages/ui/src/i18n/ja/assembly.json`(実在を確認)へ追加。help は 11b でまとめて。

## 3. 編集所有ファイル / 読取専用

- 編集所有: 新規 `packages/ui/src/assembly/attachAssembly.ts` / `.test.ts`、`packages/ui/src/store/assemblySlice.ts` / `.test.ts`、`packages/ui/src/store/documentKind.ts` / `.test.ts`、新規 `packages/ui/src/file/assemblyFile.ts` / `.test.ts`(開く / 保存 / 新規)、`packages/ui/src/file/fileGateway.ts` / `.test.ts`(`.pcada` の口の追加だけ)、`packages/ui/src/file/partFile.ts`(共通の入口への分岐だけ)、`packages/ui/src/file/attachAutoSave.ts` / `.test.ts`(アセンブリの saver)、`packages/ui/src/store/attachKernel.ts` / `.test.ts`(アセンブリの再計算の接続。part の経路は変えない)、`packages/ui/src/viewport/ViewportCanvas.tsx`(:474-519 の実配線)、`packages/ui/src/shell/AssemblyTree.tsx`(`openAssembly` 直接更新 → 履歴経由)、`packages/ui/src/app/PointerCadApp.tsx`(attach と stats)、`packages/ui/src/i18n/ja/assembly.json`、`apps/desktop/src/main/pcadDialogs.ts` / `apps/desktop/src/preload/preload.ts` / `apps/desktop/src/renderer/desktopFileGateway.ts`(`.pcada` の開く / 保存の IPC。R-10 の送信元検証を通す)、`packages/model/src/index.ts`(必要な export の追加だけ。タスク14 の `export * from './assembly/constraints/mateResiduals.js'`、タスク15 の `solveRigid` / `solveMates` の export も**ここで一緒に足す**)。
- 読取専用: `packages/model/src/assembly/*`(11a-1・49・14・15 の成果。変えない)、`packages/model/src/kernelBridge.ts`、`packages/io/src/*`、`packages/kernel/*`、`packages/ui/src/viewport/createAssemblyLayer.ts`(使うだけ。変更が要るなら止まって報告)、`packages/ui/src/store/useAppStore.ts`(スライス合成。新しいスライスは足さない)、`docs/plans/P7-アセンブリ.md`「タスク11a」「タスク11b」の節、§0.a-0.62・0.63、`docs/reviews/…` R4-1・R4-3・R6-1。
- 触らない: `packages/ui/src/store/*.test.ts` のうち上記以外、`e2e/`(E2E はタスク 11b / 48 で)、model / io / kernel の本体。

## 4. 手順と中間報告(各段階の終わりに `progress.md` へ追記)

1. **現在値**: §1 の行番号・名前の一致を確認(行はずれていてよい)。`pnpm --filter @pointercad/ui exec vitest run assembly documentKind attachKernel attachAutoSave fileGateway partFile` の件数。既存の part の経路(開く・保存・自動保存・再計算・Undo)の入口を 15 行以内で図にする(`progress.md`)。
2. **共通の入口 + attachAssembly**(再計算・世代・取消・欠落の再取得)+ 単体テスト(偽の bridge: 同一部品 2 個は 1 回だけ再計算、別 STEP の 2 部品は鍵が混ざらない(11a-1 のダイジェスト)、古い世代の結果を適用しない、`pendingWaiters()` が成功・失敗・dispose 後に 0)。
3. **保存 / 開く / 新規 / 自動保存**(`.pcada`、token、saver の切替)+ テスト(配置 → 変更 → Undo → 保存 → 開き直し → 部品更新が成立、dirty / タイトル / 自動保存の対象がアセンブリ、part の既存テストが全緑のまま)。
4. **ビューポートの実配線 + AssemblyTree の履歴経由 + stats + 文言**。
5. **検査**: `pnpm --filter @pointercad/ui run test`(全緑。件数。R-11 の分割後 3,038 件から減らない)、`pnpm -w run typecheck`(所有ファイル起因 0)、`pnpm exec eslint <編集ファイル>`、`pnpm --filter @pointercad/desktop run build`(3 本成功。アプリは起動しない)。

## 5. 合格条件(数値)

- 計画タスク11a の合格条件: 別 STEP の部品 2 種 + 同一部品 2 個を同一 Worker で交互に解決して寸法が混ざらない、配置 → 変更 → Undo → 保存 → 開き直し → 部品更新が成立、dirty / title / 自動保存の対象が assembly、文書 / session ごとに添付と自動保存を区別、RPC の成功・失敗・dispose 後に待機登録数 0、Worker 破損時に永遠に待たない — **全部が単体テストで緑**(新規 20 件以上)。
- ui のテストが全緑で件数が減っていない。typecheck 0、lint 0、desktop build 3/3。`packages/model/src/index.ts` に 14・15 の export が足され、model の typecheck が緑。
- 鏡・クリッピングは触っていない(diff に無い)。

## 6. 変更・緩和してはいけないもの

model / io / kernel の本体、`createAssemblyLayer.ts` の方式、part の既存の経路の振る舞い、既存テストの期待値(仕様変更に伴う更新は共通規律 6 の例外の範囲で列挙)、`e2e/`、性能予算、`package.json`。

## 7. 関係する過去の失敗(rules/06)

10.17(単一文書の切替は documentVersion で消去 → アセンブリでも同じ流儀)、10.11・10.20(共有ファイル: `index.ts` の export と新規ファイルを同じ報告に列挙)、10.19(欠落・取消・失敗を言い分ける)、10.5・10.10(Electron・preview を起動しない。実機は統括)。

## 8. 使える道具

`rg`、`sed -n`、`pnpm --filter @pointercad/ui exec vitest run <名前>`、`pnpm --filter @pointercad/ui run test`、`pnpm --filter @pointercad/desktop run build`、`pnpm -w run typecheck`、`pnpm exec eslint <ファイル>`。

## 9. 成果物

`__OUT__/report.md`(入口の図、API の使い方、変更ファイル、テスト件数の前後、11b への申し送り(配置操作が呼ぶ口)、統括への依頼(Electron 実機の台本項目・E2E の追加))、`__OUT__/progress.md`。最終メッセージは要約 5 行 + 規律の 2 行。

## 10. 第 1 回からの申し送り(統括の回答: 各項目の「代案」= 本担当の編集所有に加える)

第 1 回の担当は編集前に 3 件の前提相違を見つけて停止した(正しい対応)。統括の決定: **すべて本担当の所有範囲に加えて、本担当が実装する**(依存担当は今いない。順序は下記)。

1. **`resolveAssembly` に `resolvedParts` の入力が無い**(`packages/model/src/assembly/resolveAssembly.ts:92` の `ResolveAssemblyOptions` は `library` / `parent` / `standardPart` だけ、`:285` で `resolvePart(...)` を自分で呼ぶ)。→ `resolveAssembly.ts` と `.test.ts` を編集所有に加え、`resolvedParts?: ReadonlyMap<partRef, ResolvedPart>`(既に再計算済みの部品を渡す入力)を足す。**未指定時の既存の挙動は不変**(既存テストがそのまま緑)。指定時は同じ partRef の再解決をしない。テスト 3 件以上(未指定 = 従来、指定 = 再解決しない、指定に無い partRef は従来どおり解決)。
2. **`releasePart(partId)` と欠落情報(`missingKeys`)が model の橋に公開されていない**(kernel の `kernelApi.ts:445,511` にはある。`kernelBridge.ts:1215` `KernelBridge` / `:2611` `MonitoredKernelBridge` に無い)。→ `packages/model/src/kernelBridge.ts` と `.test.ts` を編集所有に加え、`releasePart(partId): Promise<void>` の素通しと、再計算の結果に含まれる欠落の構造化情報(`missingKeys` 相当)の型を公開する(既存のメソッドと戻り値は不変。R1-4 の待機通知の集合を経由し、成功・失敗・dispose・破損で待機登録が 0 になる既存テストの流儀で 2 件以上)。kernel 本体は変えない(足りなければ止まって報告)。
3. **外観の継承が描画層に無い**(`createAssemblyLayer.ts:57,72,142,248,409,439`: 入力は `bodies` だけ、インスタンスは単一の `appearance`、`component.appearance ?? DEFAULT_APPEARANCE` で部品の外観を飛ばし、全メッシュに単一材質)。→ `packages/ui/src/viewport/createAssemblyLayer.ts` と `.test.ts` を編集所有に加え、**最小の拡張**: 入力に部品ごとの面 / ボディ外観表(`createSolidLayer.ts` が使う `buildSolidGeometry(bodies, appearances, …)` と同じ型)を受け、優先順 = インスタンス上書き → 部品の面 / ボディ外観 → 既定。共有形状 + Group の方式は維持。鏡・クリッピングは触らない。テスト 3 件以上(上書きあり / 部品外観のみ / 既定)。
4. **dirty / タイトル / 帯の読み手**: `packages/ui/src/shell/AppShell.tsx:139`、`packages/ui/src/shell/StatusBar.tsx:189`、`packages/ui/src/shell/menus/fileToolbarActions.tsx:189` は `hasUnsavedChanges(state.document, state.savedDocument)` と part だけを渡す。→ 3 ファイルを編集所有に加え、共通の「いまの文書」selector(part / assembly)を経由する。part のときの結果は不変(既存テスト緑)。

順序: 1 → 2 → 3 → §2 の 1〜8。第 1 回の確認(`releasePart` は kernel に実在、`partId` は options に実在、現在値テスト 185 件緑、part 経路 11 行の図)はそのまま使う。**この 4 件を理由に再び止まらない。** 他に依存 API が無い場合だけ、その名前を書いて止まる。

## 11. 第 2 回からの申し送り(統括の回答)

第 2 回の担当は §10 の依存拡張 3 件と `model/index.ts` の export を実装した(コミット待ち行列 1495: `resolveAssembly.ts` の `resolvedParts`、`kernelBridge.ts` の `releasePart(partId)` と `checkShapeAvailability(partRef, bodyKeys) → { partId, missingKeys }`、`createAssemblyLayer.ts` の `appearances` 入力と優先順。UI 3,041 件・model 54 件緑、desktop build 3/3)。その上で「`recomputePart` の最終 `ResolvedPart` を取得する口が無い」(`recomputePart.ts:72` の `PartRecomputeResult` に無く、`:635` の `resolved` は戻り値 `:767-790` に公開されない)と見つけて停止した(正しい対応)。

**統括の決定: 推奨案(通知方式)。** `packages/model/src/part/recomputePart.ts` と `recomputePart.test.ts` を編集所有に加え、`PartRecomputeOptions.onResolved?: (resolved: ResolvedPart) => void` を足す(最終巡回が確定し取消でない時点で、同じ参照を 1 回だけ通知。未指定時の振る舞いは不変。既存テストは全部そのまま緑。新規テスト 2 件: 通知される / 取消では通知されない)。`PartRecomputeResult` の形は変えない。

再開の手順: `onResolved` → §2 の 1〜8(共通の入口、`attachAssembly.ts`、`assemblyFile.ts`、gateway / desktop IPC、文書別 saver、`ViewportCanvas.tsx` の実配線、`AssemblyTree.tsx` の履歴経由(`applyAssembly(document, library)` 相当の確定操作の入口を作り 11b へ報告)、stats、dirty / title、文言)。第 2 回の「API の使い方」の節(`resolveAssembly(document, { library, resolvedParts })`、`bridge.checkShapeAvailability` → `missingKeys` が空でなければ再計算、`bridge.releasePart`、`buildAssemblyGeometry({ …, appearances })`)をそのまま使う。**この理由で再び止まらない。** 待ち行列 1495 が着地するまで `resolveAssembly.ts` / `kernelBridge.ts` / `createAssemblyLayer.ts` / `model/index.ts` には触らない(統括が着地を確認してから起動する。追加の変更が要れば report に書く)。合格条件は §5 のまま(新規テスト 20 件以上は第 2 回の 13 件と合算でよい)。

## 12. 第 3 回からの申し送り(統括の回答: 所有を 2 ファイル追加。仕上げて着地させる)

第 3 回の担当は 27 ファイル(新規 4)を編集し新規検査 30 件を足した(`onResolved`、`attachAssembly.ts`、`assemblyFile.ts`、gateway / desktop IPC の `.pcada`、文書別 saver、`ViewportCanvas` の実配線、`AssemblyTree` の `applyAssembly`、stats、共通 dirty / title、文言)。UI 3,067 合格 / **1 失敗**(`packages/ui/src/store/storeSlices.test.ts:75`「作る欄が重なっていない」= `assemblySlice.ts` が `applyDocument / resetDocument / undo / redo` の 4 操作を上書きしたため)。あわせて `assemblySlice.ts` が `createDocumentSlice` を値として import している点が `viewSlice.ts` 冒頭の「スライス同士を import しない」に反する。`Toolbar.tsx:254/270` も `store.undo()/redo()` を直接呼ぶ。**作業ツリーの差分は未完成でコミット不可**(統括はコミットしていない。あなたはこの差分の上で続ける)。

**統括の決定: 推奨案。** `packages/ui/src/store/documentSlice.ts` と `documentSlice.test.ts`、`packages/ui/src/shell/Toolbar.tsx`(と対応する test があればそれ)を編集所有に加える。方針:
1. **4 操作の所有者は `documentSlice.ts` のまま**。その中で `activeDocumentKind(get())` により assembly 専用の操作(`assemblySlice` が持つ `applyAssembly` / `resetAssembly` / assembly の undo・redo)へ分岐する。`assemblySlice.ts` から 4 操作の上書きと `createDocumentSlice` の値 import を**取り除く**(スライス同士を import しない)。分岐の相手は `get()` 経由の口(型は `appState.ts` に置く)。
2. `storeSlices.test.ts:75`(重複禁止)は**そのまま通す**(期待値を変えない)。
3. `Toolbar.tsx` の Undo / Redo の直接呼び出しは、共通の入口(`documentSlice` の undo / redo が種別で分岐するなら、そのままでよい。分岐が別関数なら差し替える)。
4. 仕上げ: `pnpm --filter @pointercad/ui run test` 全緑(3,068 件以上、失敗 0)、`pnpm --filter @pointercad/model run test` 全緑、`pnpm -w run typecheck` 0、`pnpm exec eslint` 0(警告 1 件も直す: `assembly.json` は設定対象外なら報告)、`pnpm --filter @pointercad/desktop run build` 3/3。
5. report.md に「変更ファイルの全一覧(新規は明記)」「仕様変更に伴う既存テストの更新の一覧」「11b が呼ぶ口(`applyAssembly` の名前と型)」「Electron 実機の台本項目」「E2E の追加項目」を書く。

**この理由で再び止まらない。**(他に所有外が要るなら、その 1 件だけ報告して止まる。)
