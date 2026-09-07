# 指示書 E-1(第 7 回): 「保存の直後に新規」の競合を直す(台本だけ。実行は統括)

## 0. 例外(第 1 回と同じ)
成果物はリポジトリの外(報告先 `__OUT__`)。リポジトリのファイルは変更しない。Electron・ブラウザ・開発サーバーを起動しない。

## 1. 統括の実行結果 v6(`C:/Users/oltot/AppData/Local/Temp/claude/C--Users-oltot-Documents-git-projects-PointerCAD/97bbbc31-8178-49a4-b3da-7d4a3d793e68/scratchpad/codex/electron-check-r-v6/run-6.log`)と原因
- OK 9 / NG 2 / SKIP 1。**R1-1「新規の空文書へ切り替わらなかった」**と R10-2「R10-2 前の空文書へ切り替わらなかった」。v3・v4・v5 では R1-1 は合格、v2 と v6 で失敗 → **同じ台本でも落ちたり通ったりする競合**。v5 → v6 の diff は R10-2 の中だけで、共通の `newPart`(:149-156)は不変。
- 原因の見立て: R1-1 は「A を保存(Ctrl+S)→ すぐ『新規』」。保存の完了(`setFileState` で `savedDocument` が更新され、状態欄の `*` が消える)より前に「新規」を押すと、アプリの `newPart` は `mayDiscard`(未保存の確認)を出して止まる(ユーザーの確認待ち)→ 空の案内は出ない。R10-2 の「新規化」も R1-3 の保存直後なので同じ。v3〜v5 は偶然間に合っていた。
- 参考: 空の案内が出る条件(`AppShell.tsx:107-126,325-429`)は「単位の質問なし・復元案内なし・`isComputing=false`・部品文書・solid 0・reference 0・sketch feature 0」。

## 2. やること(v6 を写して直す)
1. 共通ヘルパー `newPart(page)`: クリックの**前**に「保存が完了している」ことを待つ = 状態欄のファイル名に `*` が無い(未保存印なし)**かつ** `window.pcadRecomputeStats().isComputing === false`(`page.evaluate`)。クリックの**後**は、①空の案内(`.pcad-viewport__empty-state`)が出る、または ②未保存の確認(破棄の確認の要素。実物の DOM を `packages/ui/src/shell/AppShell.tsx` / `packages/ui/src/file/partFile.ts` の `mayDiscard` の実装から特定)が出たら**その事実を requireThat の文言に含めて失敗**させる(何が起きたか分かる形)。
2. R1-1 の「A 保存 → 新規」の間と、R10-2 の「新規化」は上の `newPart` を使う(直接 click しない)。
3. Ctrl+S の後の「保存完了」の待ちは、既存の `statSync(A_PATH).mtimeMs > mtimeBefore` に加えて、状態欄の `*` が消えることも待つ(R1-1・R1-3・R10-2 の共通)。
4. 他の項目は 1 文字も変えない。`node --check` 0 エラー。README に「v7 の変更点」3 行。

## 3. 編集所有 / 読取専用
- 編集所有: `__OUT__/electron-check-r.mjs`(v6 の写し + 上記)、`__OUT__/README.md`、`__OUT__/report.md`、`__OUT__/progress.md`。
- 読取専用: v1〜v6 の台本と log、`packages/ui/src/shell/AppShell.tsx`、`packages/ui/src/file/partFile.ts`(`mayDiscard`・`newPart`)、`packages/ui/src/shell/StatusBar.tsx`(ファイル名と `*` の描き方)。
- 触らない: リポジトリ内の全ファイル。

## 4. 合格条件
`diff <v6> <v7>` の差分が `newPart` と保存完了の待ち・R1-1 / R10-2 の呼び方・README だけ、`node --check` 0 エラー、`git status` に自担当の変更なし。

## 5. 成果物
上記 4 ファイル。最終メッセージは要約 3 行 + 規律の 2 行。
