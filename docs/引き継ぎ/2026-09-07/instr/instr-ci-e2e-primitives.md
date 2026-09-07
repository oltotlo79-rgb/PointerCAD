# 指示書 C-1: CI(windows)の E2E 1 件の失敗の原因を切り分ける(読んで報告。必要なら最小の修正案)

## 0. 例外
Playwright は起動しない(統括が実行する)。修正は**原因が製品コードの欠陥だと判明した場合だけ**、編集所有の範囲で行う。期待値・待ち時間の上限(`KERNEL_TIMEOUT_MS = 60_000`、workers=2、既定の expect の 30 秒)は変えない。

## 1. 事実(GitHub Actions、windows-latest、push #18 = HEAD 692efea。利用者が貼ったログ)
- 単体(kernel 1,317・model 2,327・io 707・ui 3,038 ほか)、build(desktop 3 本、web の occt/manifest.json + 13,859.56 kB の .bin)は全部緑。
- E2E: 77 件中 **76 合格・1 失敗**(5.5 分、workers 2)。失敗は `e2e/tests/primitives.spec.ts:560`「2 点を選ぶと距離が出て、アルミの立体は質量が出る(FR-1101、FR-1102)」。**最初の行** `await page.goto('/'); await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');` が 30 秒で `element(s) not found`。同じ spec の他の 3 件(:432、:478、:611)は合格。同じ commit で ubuntu の CI と手元の Windows(push 前検査、16:32〜16:45)は 77 件全部合格。以前の commit(c96b473、d5b9df4)では windows の CI もこのテストを含めて合格していた。
- 今日の変更で初期画面に関わりうるもの: R-2(自動保存: IndexedDB の失敗を握りつぶさず通知、読めない控えを残す。`packages/io/src/autoSave.ts`、`packages/ui/src/file/attachAutoSave.ts`、`packages/ui/src/shell/AppShell.tsx`、`fileSlice.ts`)、R-7b / P7 52(`attachKernel.ts` の世代と `recomputeSlice.ts` の `lastOutcome`、`PointerCadApp.tsx` の検査用 stats)、R-12(`loadOcct.browser.ts` が `${BASE_URL}occt/manifest.json` を fetch → gzip 展開 → wasmBinary。Worker の中)、R-1(保存先)、R-5(点検メッシュ)。

## 2. やること(読むだけ。順に)
1. `rg -n "pcad-viewport__empty-state" packages/ui/src` で空の案内がどの条件で描かれ、**どの条件で消えるか**(例: 文書に要素がある、復元の案内が出ている、自動保存の失敗の帯、アセンブリを開いている、読み込み中)を列挙する。
2. `primitives.spec.ts:556-575` を読み、この test だけが他の 3 件と違う前準備(`page.goto` の直後に案内を待つ)をしていないかを見る。他の spec が初回に何を待っているか(`e2e/tests/recompute.ts` の共通 helper、`beforeEach`)と比べる。
3. **仮説を 3 つ以上**立て、それぞれをコードで肯定/否定する: (a) 共有ランナーの遅さで React の描画自体が 30 秒を越えた(この場合、他の spec の初回も同じ条件のはずなので、なぜこの 1 件だけかを説明する)、(b) 新しい自動保存の失敗通知や復元の案内が初期画面で案内を隠す/差し替える経路がある(Playwright の新しい context では IndexedDB は空。R-2 で「IndexedDB が無いとき」の扱いが変わった。ランナーの環境で `indexedDB.open` が失敗し得るか)、(c) R-12 の manifest fetch の失敗や遅延が main thread の描画や `isComputing` の初期値に影響する経路、(d) P7 52 の `lastOutcome` の初期値 `idle` で空の案内の条件が変わった、(e) テストの並び(worker の使い回し)で前のテストの状態が残る経路(Playwright の context の分離を確認)。
4. 結論: 原因の候補を確度順に並べ、**製品の欠陥なら最小の修正**(編集所有の範囲)を行いテストを足す。**環境要因なら修正せず**、統括が取れる手(再実行、ランナーでの追加ログ)を書く。テストの待ち方を変える案があるなら「期待値・上限を緩めない」範囲で提案だけ(実装は統括の判断後)。

## 3. 編集所有 / 読取専用
- 編集所有(原因が欠陥のときだけ): `packages/ui/src/file/attachAutoSave.ts`・`.test.ts`、`packages/ui/src/shell/AppShell.tsx`、`packages/ui/src/viewport/*.tsx`(空の案内の描画条件)、`packages/ui/src/store/fileSlice.ts`、対応する `.test.ts`。
- 読取専用: `e2e/tests/*.ts`(**変えない**)、`packages/io/src/autoSave.ts`、`packages/kernel/src/occt/loadOcct.browser.ts`、`packages/ui/src/store/attachKernel.ts`・`recomputeSlice.ts`、`packages/ui/src/app/PointerCadApp.tsx`、`e2e/playwright.config.ts`。
- 触らない: kernel、model、io、`e2e/`、上限の数値。

## 4. 合格条件
report.md に「消える条件の一覧」「仮説 3 つ以上と肯定/否定の根拠(ファイル:行)」「結論と確度」「統括への提案」がある。修正した場合は ui のテストが全緑(件数)、typecheck 0、lint 0。

## 5. 関係する過去の失敗(rules/06)
10.12・10.14・10.18(共有ランナーの時間依存。上限を伸ばして逃げない)、10.19(未完了を別の理由で断らない)。

## 6. 成果物
`__OUT__/report.md`、`__OUT__/progress.md`。最終メッセージは要約 5 行 + 規律の 2 行。
