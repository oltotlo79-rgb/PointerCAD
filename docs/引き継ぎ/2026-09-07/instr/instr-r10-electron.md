# 指示書 R-10: Electron の狭い preload を保ち、送信元の検証・遷移の制限・保存の原子性を補う(レビュー 2026-09-07 R12-2、重大度 高、工数 M)

## 1. 目的と背景(コードで確認済み)

- `apps/desktop/src/main/main.ts:24-50` の主窓は `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`(維持する良い設定)。`:65-84` の印刷用の隠し窓は preload なし。**どちらの窓にも `will-navigate` の制限と `setWindowOpenHandler` が無い**。
- `apps/desktop/src/preload/preload.ts:20-30` は用途別の IPC(`pcad:open` / `pcad:confirmTarget` / `pcad:clearTarget` / `pcad:save` / `pcad:hasTarget` ほか)だけを出す(維持)。
- `apps/desktop/src/main/pcadDialogs.ts` の `ipcMain.handle`(`:389,405,423,427,453,457,469`)は引数の形を検証するが **`event.senderFrame` を検証しない**(別 frame や予期しない遷移先へ特権 IPC が使える余地)。`:125` の読み込みは `fileSystem.readFile(filePath)` を上限なしで全読み、`:138` の保存は `fileSystem.writeFile(filePath, bytes)` を**直接上書き**(書き込み中の異常終了で既存ファイルが途中までになる)。
- `apps/desktop/src/main/appProtocol.ts:33-47` は配信 root の外を 403 で拒む(維持)。ホスト名の確認は無い。
- Electron 公式の推奨(IPC 送信元検証、遷移/新窓の制限、最小の preload)。R-1(保存先 token、コミット `ea1fcf1`)の main 側の token 管理と共通化する。

## 2. 変更の設計(レビューの具体策)

- 新規 `apps/desktop/src/main/appSender.ts`: `validateAppSender(event: IpcMainInvokeEvent): boolean`。既知の `BrowserWindow`(main が作った主窓)の **mainFrame からの呼び出し**で、かつ `event.senderFrame.url` が正確に app scheme(`appProtocol.ts` の `APP_SCHEME`)+ host、または開発時だけ許す `devServerUrl` の origin であることを確かめる。**すべての `ipcMain.handle` の先頭で呼び、偽なら何もせず失敗(例外ではなく null / false の既存の失敗の形)を返す。**
- `main.ts`: 主窓と印刷窓の両方に `webContents.on('will-navigate', …)` で app URL(と dev の URL)以外への遷移を拒否、`webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`。外部リンクを OS のブラウザで開く口は**今回は作らない**(P11b タスク 1 が固定 https 許可表つきで足す。その置き場を注記で示す)。`appProtocol.ts` で `url.host` が期待する host 以外なら 403。
- `pcadDialogs.ts`: 保存は **同じディレクトリの一時ファイル(例 `<name>.pcad.tmp-<乱数>`)へ書き終えてから置換**(`rename`。Windows で既存ファイルへの `rename` が失敗する場合は `copyFile` + `unlink` などの順序で「元ファイルが消えたのに新ファイルが無い」瞬間を作らない手順にし、採った手順と根拠を報告)。失敗時は元ファイルを保ち、一時ファイルを消す。読み込みは `stat` でサイズを見て上限を超えたら読まずに拒否(上限は `packages/io/src/limits.ts` の圧縮入力の上限 256 MiB と同じ値。desktop が `@pointercad/io` に依存していればその定数を import、していなければ desktop 側に同名の定数を置き、報告に「io と二重定義」と書く)。
- R-1 の token(`pcad:confirmTarget` / `pcad:clearTarget`)の管理は変えない。同じ `validateAppSender` を通すだけ。

## 3. 編集所有ファイル / 読取専用

- 編集所有: `apps/desktop/src/main/main.ts`、`apps/desktop/src/main/pcadDialogs.ts`、`apps/desktop/src/main/appProtocol.ts`、新規 `apps/desktop/src/main/appSender.ts`、`fileSystem` の抽象を定義しているファイル(`rg -n "fileSystem" apps/desktop/src/main/pcadDialogs.ts` で import 元を確かめ、`stat` / `rename` などの口を足す必要があればそのファイル。実在を報告してから編集)。
- 読取専用: `apps/desktop/src/preload/preload.ts`(変えない。変える必要が出たら止まって報告)、`apps/desktop/src/renderer/*`、`packages/io/src/limits.ts`(R-9 の成果。待ち行列で着地待ち。値の確認だけ)、`apps/desktop/package.json`(依存の確認だけ。**変えない**)。
- 触らない: `packages/*`、`apps/web`、`.github`、`scripts`。

## 4. 手順と中間報告(各段階の終わりに `progress.md` へ追記)

1. **現在値**: §1 の行番号・関数名の一致を確認。`ipcMain.handle` の全件(チャンネル名)を列挙。`fileSystem` の抽象の場所と口。desktop が `@pointercad/io` に依存しているか。`pnpm --filter @pointercad/desktop exec tsc --noEmit -p .`(または `pnpm -w run typecheck`)でエラー 0 を確認(着手前)。
2. **appSender.ts** と全 handler への適用。
3. **main.ts** の遷移・新窓の制限、**appProtocol.ts** の host 確認。
4. **pcadDialogs.ts** の原子的保存と読み込みの上限。
5. **検査**: apps/desktop にはテストが無い。`pnpm -w run typecheck`(所有ファイル起因 0)、`pnpm exec eslint apps/desktop/src/main/*.ts`、`pnpm --filter @pointercad/desktop run build`(vite の 3 本のビルドが成功。**アプリは起動しない**。ビルドの出力は既定の場所でよいが、repo 直下の `scratchpad/` や `apps/web/dist/` には置かない)。加えて **統括が Electron 実機で確かめる台本**を report.md に書く: ①「A を開く → 保存」で元ファイルと同じ内容・一時ファイルが残らない、②保存中に失敗させる手(例: 読み取り専用のフォルダ)で元ファイルが無事、③外部 URL への遷移や `window.open` が起きない(devtools の console で `location.href = 'https://example.com'` を試す)、④256 MiB 超のファイルを開こうとすると拒否の文言が出る。

## 5. 合格条件(数値)

- `rg -c "validateAppSender\(" apps/desktop/src/main/pcadDialogs.ts` が `ipcMain.handle` の件数以上(全 handler で呼ぶ)。
- `rg -n "will-navigate|setWindowOpenHandler" apps/desktop/src/main/main.ts` がそれぞれ 2 件以上(主窓と印刷窓)。
- `rg -n "writeFile\(" apps/desktop/src/main/pcadDialogs.ts` の直接上書きが 0 行(一時ファイル → 置換の経路だけ)。読み込みの前に `stat` と上限比較がある。
- typecheck 0(所有ファイル起因)、lint 0、desktop の build 成功(3 本)。
- preload.ts に差分が無い。

## 6. 変更・緩和してはいけないもの

`contextIsolation` / `nodeIntegration` / `sandbox` の 3 設定、preload の口の数、R-1 の token 管理、renderer へ実パスを出さない方針、`package.json`、`packages/*`。

## 7. 関係する過去の失敗(rules/06)

10.5(担当が Electron を起動して真っ暗な窓 → **起動しない**。実機確認は統括)、10.10(担当が起動したプロセスの止め忘れ → 起動しないので該当なし)、10.11(共有ファイル: `preload.ts` は他の担当との接点なので変えない)。

## 8. 使える道具

`rg`、`sed -n`、`pnpm -w run typecheck`、`pnpm exec eslint <ファイル>`、`pnpm --filter @pointercad/desktop run build`。Electron の起動・ブラウザは禁止。

## 9. 成果物

`__OUT__/report.md`(handler の一覧と検証の有無、原子的保存の手順と根拠、上限の定数の置き場、build の結果、統括向けの実機台本 4 項目、統括への依頼)、`__OUT__/progress.md`。最終メッセージは要約 5 行 + 規律の 2 行。
