# 指示書 R-1: 保存先を文書と一緒に確定・解除する(レビュー 2026-09-07 R5-1、重大度 高、工数 M)

## 1. 目的と背景

いまの実装では、保存先(上書き先)の記憶が「窓」の属性で「正常に開いた/保存した現在の文書」の属性になっていないため、次の 2 つが起きうる(gpt-6-astra のレビュー R5-1、コードで確認済み):

- (a) 部品 A を開く → 「新規」→ Ctrl+S で **A を上書き**する。`packages/ui/src/file/partFile.ts:298-304` の `newPart` は文書と fileState をリセットするが gateway の保存先を解除しない。`:366-369` の保存は `store.fileGateway.hasSaveTarget()` で判定する。
- (b) A を表示中に壊れた B を開く → 読み込み拒否(`partFile.ts:325-328` 付近の構文検証)→ Ctrl+S で **画面の A の内容を B へ書く**。Web の `packages/ui/src/file/fileGateway.ts:718-723` と Electron の `apps/desktop/src/main/pcadDialogs.ts:352-358`(`rememberPath(event, opened.path)`)は、partFile 側の検証より前に開いた先を記憶するため。

## 2. 変更の設計(レビューの具体策。これに従う)

- `FileGateway`(`packages/ui/src/file/fileGateway.ts`)に **保存先の解除** `clearSaveTarget(): void` と、**開いた先の確定** を足す。`openPcad` は開いた先をすぐ保存先にせず、**不透明な token**(文字列)を結果に含めて返す。partFile 側で `readPartDocument` が成功し文書を適用し終えてから `confirmSaveTarget(token)` を呼び、そこで初めて保存先になる。失敗・取消なら確定しない(前の保存先を保つ)。
- **解除する場面**: 新規作成(`newPart`)、ひな形からの新規(`templateFile.ts` に該当があれば)、自動保存からの復元の適用、文書の種類の切替(アセンブリを開く等)。復元の適用は `attachAutoSave.ts`(他担当 R-2 の所有)にあるので、**あなたは編集せず**、必要な呼び出し(`clearSaveTarget()`)を報告書の「統括への依頼」に書く。
- Electron: main(`apps/desktop/src/main/pcadDialogs.ts`)は token → 実パスの対応を持ち、renderer へ実パスを出さない(既存の方針を保つ)。確定で現在の保存先へ移し、解除で消す。未確定の token は次に開くとき捨てる。
- 「保存先が無ければ名前を付けて保存の窓を出す」既存の振る舞いは保つ。

## 3. 編集所有ファイル / 読取専用の依存

- 編集所有: `packages/ui/src/file/fileGateway.ts`、`packages/ui/src/file/partFile.ts`、`packages/ui/src/file/templateFile.ts`(ひな形から新規の経路に保存先の解除が要る場合だけ)、これらの既存テスト(`packages/ui/src/file/*.test.ts` のうち上記 3 ファイルに対応するもの。無ければ新規 `packages/ui/src/file/partFile.saveTarget.test.ts`)、`apps/desktop/src/main/pcadDialogs.ts`、`apps/desktop/src/preload/preload.ts`(IPC の形が変わる場合だけ)、Electron 側の IPC 型を置いているファイル(`apps/desktop/src` 内で `openPcad` の型を定義している 1 ファイル。実在を確かめてから編集)。
- 読取専用: `packages/ui/src/store/fileSlice.ts`、`packages/ui/src/store/documentSlice.ts`、`packages/ui/src/file/attachAutoSave.ts`(R-2 の所有)、`packages/ui/src/file/exchangeFile.ts`、`packages/io/src/pcad/*`、`docs/plans/P6-入出力.md` §0.a-0.4(保存先の既決事項)。
- 触らない: `packages/ui/src/store/*.test.ts`(別担当 R-11 が分割中)、`packages/ui/src/i18n/ja/*.json`(新しい文言が要るなら鍵名と文面を報告に書き、既存の文言で代用して実装する)、`packages/io/src/autoSave.ts`(R-2)。

## 4. 手順と中間報告(各段階の終わりに `progress.md` へ追記)

1. **現在値の確認**: 上記 §1 の行番号と関数名が実物と一致するか `sed -n` で確認。`openPcad(` / `hasSaveTarget(` / `rememberPath(` の呼び出し元を `rg` で全件列挙して報告(所有外の呼び出し元があれば、そのファイル名と必要な変更を「統括への依頼」に書き、自分では編集しない)。既存のテストの件数を `pnpm --filter @pointercad/ui exec vitest run file/` で記録。
2. **gateway の契約**を変える(型 → Web 実装 → Electron 実装)。`fileGateway.ts:64` 付近の注記「上書き先は覚えない(§0.a-0.4)」は新しい振る舞いに合わせて書き直す(古い注記を残さない。rules/06 10.17)。
3. **partFile の配線**(開く: 成功後に確定、失敗・取消は確定しない。新規: 解除)。
4. **テスト**(vitest、gateway はモック): ①A を開く → 新規 → 保存 → gateway の保存が `saveAs=true` で呼ばれる(A のバイト列は変わらない)。②A を開く → 読めない B を開く(readPartDocument が失敗するバイト列)→ 保存 → 保存先は A のまま(B には書かない)。③A を開く → 開く窓を取消 → 保存先は A のまま。④A を開く → 保存 → もう一度保存 → 2 回目も窓なし(既存の振る舞い)。⑤新規 → 保存 → 窓あり。
5. **検査**: `pnpm --filter @pointercad/ui exec vitest run file/`(全緑、件数を報告)、`pnpm --filter @pointercad/ui run test`(全緑。件数)、`pnpm -w run typecheck`、`pnpm exec eslint <編集ファイル>`。

## 5. 合格条件(数値)

- §4-4 の 5 場面のテストが全緑(新規テスト 5 件以上)。
- ui パッケージのテストが全緑で、着手前より件数が減っていない(着手前の値を報告に書く)。
- typecheck: 自分の所有ファイル起因のエラー 0(`apps/desktop` を含む)。lint: 編集ファイルの警告・エラー 0。
- `rg "rememberPath\(event, opened.path\)" apps/desktop/src/main/pcadDialogs.ts` が 0 行(開いた直後の記憶が無い)。

## 6. 変更・緩和してはいけないもの

`.pcad` の形式、自動保存(R-2 の範囲)、ストアのスライス、i18n の JSON、既存テストの期待値、renderer へ実パスを渡さない方針、`package.json`。

## 7. 関係する過去の失敗(rules/06)

10.17(文書をまたぐ覚え書きの差し替え漏れ → `fileGateway.ts:64` の注記と P6 計画 §0.a-0.4 の記述がずれる。計画書は触らず、ずれを報告に書く)。10.4(`git stash` 禁止)。10.11(共有ファイル: `attachAutoSave.ts` と `i18n` は他担当。触らない)。

## 8. 使える道具

`rg`、`sed -n`、`pnpm --filter @pointercad/ui exec vitest run <名前>`、`pnpm -w run typecheck`、`pnpm exec eslint <ファイル>`。Electron の実機確認は統括が後で行う(あなたは起動しない)。

## 9. 成果物

`__OUT__/report.md`(変更ファイル、呼び出し元の一覧、テスト件数の前後、統括への依頼: `attachAutoSave.ts` での `clearSaveTarget()` 呼び出し・必要な文言・所有外の呼び出し元)、`__OUT__/progress.md`。最終メッセージは要約 5 行 + 規律の 2 行。
