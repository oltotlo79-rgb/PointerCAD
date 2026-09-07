# 指示書 E-1(第 8 回): 失敗点の診断出力を足す(台本だけ。実行は統括)

## 0. 例外(第 1 回と同じ)
成果物はリポジトリの外(報告先 `__OUT__`)。リポジトリのファイルは変更しない。Electron・ブラウザ・開発サーバーを起動しない。

## 1. 統括の実行結果 v7(`C:/Users/oltot/AppData/Local/Temp/claude/C--Users-oltot-Documents-git-projects-PointerCAD/97bbbc31-8178-49a4-b3da-7d4a3d793e68/scratchpad/codex/electron-check-r-v7/run-7.log`)
- OK 9 / NG 2 / SKIP 1。R1-1・R10-2 とも「新規」の後に**空の案内も未保存の破棄確認も出ない**(競合の検出は働いたが、どちらでもない第 3 の状態)。desktop の dist は 18:37 のまま(v5 で R1-1 合格、v6・v7 で失敗。同じ dist)。
- つまり「新規」を押した後のアプリの状態が分からない。**次は失敗点の診断を出す。**

## 2. やること(v7 を写して、失敗時の診断だけを足す)
1. `runItem` が失敗したとき(catch 内)に、①`page.screenshot({ path: '<報告先>/fail-<項目名>.png', fullPage: true })`、②`document.body.innerText` の先頭 2,000 文字、③状態欄(`statusFile` と周辺)の文字列、④`window.pcadRecomputeStats?.()` の値、⑤`document.querySelectorAll('[role=dialog], .pcad-popover, .pcad-overlay')` 相当の可視要素のクラス名一覧(実物のクラス名は `packages/ui/src/shell/AppShell.tsx` から拾う)、⑥直近 30 件の console メッセージ、を `run.log` に `[DIAG <項目名>] …` として出力する。**他の項目の中身は 1 文字も変えない。**
2. R1-1 と R10-2 の「新規」クリックの**直前と直後**にも同じ診断を `[DIAG …]` で出す(成功時も)。
3. `node --check` 0 エラー。README に「v8 の変更点」3 行。

## 3. 編集所有 / 読取専用
- 編集所有: `__OUT__/electron-check-r.mjs`(v7 の写し + 診断)、`__OUT__/README.md`、`__OUT__/report.md`、`__OUT__/progress.md`。
- 読取専用: v7 の台本と log、`packages/ui/src/shell/AppShell.tsx`(overlay / popover のクラス名)。
- 触らない: リポジトリ内の全ファイル。

## 4. 合格条件
`diff <v7> <v8>` の差分が診断の追加だけ、`node --check` 0 エラー、`git status` に自担当の変更なし。

## 5. 成果物
上記 4 ファイル。最終メッセージは要約 3 行 + 規律の 2 行。
